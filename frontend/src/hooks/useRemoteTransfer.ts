import { useState, useEffect, useCallback, useRef } from 'react';
import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from 'idb-keyval';
import { P2PConnection, STUN_SERVERS } from '../lib/webrtc';
import { agentSocket } from '../lib/agentSocket';
import {
  generateECDHKeyPair,
  exportPublicKeyBase64,
  importPublicKeyBase64,
  deriveSharedKey,
  encryptChunk,
  decryptChunk,
  sha256Hex,
  type ECDHKeyPair,
} from '../lib/remoteCrypto';
import type { Transfer, Peer } from '../types';

export interface RemoteTransferState {
  shareCode: string | null;
  remotePeer: Peer | null;
  incomingTransfer: Transfer | null;
  transfers: Map<string, Transfer>;
  lastError: string | null;
  createRoom: () => void;
  joinRoom: (code: string) => void;
  sendRemoteFile: (file: File) => void;
  acceptRemoteTransfer: (transferId: string) => void;
  rejectRemoteTransfer: (transferId: string) => void;
  dismissIncoming: () => void;
  disconnect: () => void;
}

const SIGNALING_URL =
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_SIGNALING_URL ?? 'ws://localhost:4002';

// 256 KB — must match backend CHUNK_SIZE
const CHUNK_SIZE = 256 * 1024;

// Used only until agent_ready publishes the authoritative cap; reading
// agentSocket.maxAcceptedFileSize at call time lets a backend bump take
// effect without a frontend redeploy.
const FALLBACK_MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

// Per-chunk keys are `${IDB_KEY_PREFIX}${transferId}-${index}` — namespacing
// lets parallel transfers coexist and makes batch cleanup trivial.
const IDB_KEY_PREFIX = 'nexdrop-recv-';

function chunkKey(storeKey: string, index: number): string {
  return `${storeKey}-${index}`;
}

// Best-effort cleanup — swallow errors so a failure here doesn't pile on
// top of whatever already triggered the cleanup.
async function cleanupIdb(storeKey: string, totalChunks: number): Promise<void> {
  const deletes: Promise<void>[] = [];
  for (let i = 0; i < totalChunks; i++) {
    deletes.push(idbDel(chunkKey(storeKey, i)));
  }
  await Promise.all(deletes).catch(() => { /* best-effort */ });
}

/**
 * GC orphaned receive chunks from tabs killed mid-receive (close/crash/refresh).
 * The hook is the only writer of nexdrop-recv-* keys, so on a fresh mount every
 * matching key is orphaned. Active transfers use a fresh transferId so they
 * are unaffected. Errors are swallowed — IDB unavailable (private browsing,
 * quota) must not block hook initialisation.
 */
async function gcOrphanedReceiveChunks(): Promise<void> {
  try {
    const allKeys = await idbKeys();
    const orphaned: string[] = [];
    for (const k of allKeys) {
      if (typeof k === 'string' && k.startsWith(IDB_KEY_PREFIX)) {
        orphaned.push(k);
      }
    }
    if (orphaned.length === 0) return;
    await Promise.all(orphaned.map((k) => idbDel(k))).catch(() => undefined);
    console.log(`[Remote] GC: removed ${orphaned.length} orphaned IDB chunk(s)`);
  } catch {
    /* best-effort */
  }
}

export function useRemoteTransfer(): RemoteTransferState {
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [remotePeer, setRemotePeer] = useState<Peer | null>(null);
  const [transfers, setTransfers] = useState<Map<string, Transfer>>(new Map());
  const [incomingTransfer, setIncomingTransfer] = useState<Transfer | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const p2pRef = useRef<P2PConnection | null>(null);
  // Only the initiator sends the WebRTC offer when peer_joined fires; the
  // joiner waits for the 'offer' message and answers.
  const isInitiatorRef = useRef<boolean>(false);

  const keyPairRef = useRef<ECDHKeyPair | null>(null);
  const sharedKeyRef = useRef<CryptoKey | null>(null);

  /**
   * Gate that all binary chunk handlers await before decrypting. DataChannel
   * chunks can arrive before the ECDH exchange completes on low-latency links.
   * resetCrypto() creates a fresh unresolved Promise; startKeyExchange /
   * finishKeyExchange resolve it once the key is ready.
   */
  const keyReadyPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const keyReadyResolveRef = useRef<(() => void) | null>(null);
  // Checked immediately after awaiting keyReadyPromiseRef so chunk handlers
  // abort cleanly instead of producing an ambiguous "decrypt with null key" error.
  const keyDerivationFailedRef = useRef(false);

  const receiveMetaRef = useRef<{
    fileName: string;
    fileSize: number;
    totalChunks: number;
    chunksReceived: number;
    transferId: string;
    storeKey: string;
    expectedHash: string | null;
  } | null>(null);

  const pendingSendsRef = useRef<Map<string, File>>(new Map());

  /**
   * ObjectURL revoke timers keyed by transferId.
   * Revoking too early (before the browser completes the download) silently
   * fails the download; never revoking leaks blob memory for the session.
   * 1s after the link click is the sweet spot. Keyed by transferId so a
   * (defensive) double-complete cancels the old timer before creating a new URL.
   * All timers are cleared on disconnect() to prevent post-unmount callbacks.
   */
  const revokeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  function resetCrypto(): void {
    keyPairRef.current = null;
    sharedKeyRef.current = null;
    keyDerivationFailedRef.current = false;
    const promise = new Promise<void>((resolve) => {
      keyReadyResolveRef.current = resolve;
    });
    keyReadyPromiseRef.current = promise;
  }

  // On failure, set the flag and resolve the gate so waiting chunk handlers
  // unblock, see the flag, and abort instead of hanging forever.
  async function startKeyExchange(): Promise<void> {
    try {
      const pair = await generateECDHKeyPair();
      keyPairRef.current = pair;
      const b64 = await exportPublicKeyBase64(pair.publicKey);
      await p2pRef.current!.sendRaw(
        JSON.stringify({ type: 'ecdh_hello', publicKey: b64 }),
      );
    } catch (err) {
      console.error('[Crypto] Key exchange initiation failed:', err);
      keyDerivationFailedRef.current = true;
      keyReadyResolveRef.current?.();
    }
  }

  /**
   * Edge case — ecdh_hello arrives before our key pair is ready (theoretically
   * possible on a very fast link). Treat as failure rather than risk a subtle
   * crypto bug.
   */
  async function finishKeyExchange(b64RemotePubKey: string): Promise<void> {
    try {
      if (!keyPairRef.current) {
        console.error('[Crypto] Received ecdh_hello before our key pair was ready');
        keyDerivationFailedRef.current = true;
        keyReadyResolveRef.current?.();
        return;
      }
      const remotePubKey = await importPublicKeyBase64(b64RemotePubKey);
      sharedKeyRef.current = await deriveSharedKey(
        keyPairRef.current.privateKey,
        remotePubKey,
      );
      keyReadyResolveRef.current?.();
      console.log('[Crypto] ECDH complete — AES-256-GCM session key ready');
    } catch (err) {
      console.error('[Crypto] Shared key derivation failed:', err);
      keyDerivationFailedRef.current = true;
      keyReadyResolveRef.current?.();
    }
  }

  /**
   * Returns the existing WS if open, or opens a new one. When `forceFresh` is
   * true, any existing socket is closed first — used by joinRoom to leave the
   * caller's auto-created room before joining the peer's room. (The signaling
   * server enforces a one-room-per-connection invariant.)
   */
  const connectSignaling = useCallback((forceFresh = false) => {
    if (forceFresh && wsRef.current) {
      try { wsRef.current.close(); } catch { /* socket already torn down */ }
      wsRef.current = null;
    }
    if (wsRef.current?.readyState === WebSocket.OPEN) return wsRef.current;
    const ws = new WebSocket(SIGNALING_URL);
    wsRef.current = ws;

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'joined':
            setShareCode(msg.roomId);
            console.log('[Signaling] Joined room:', msg.roomId);
            break;
          case 'peer_joined':
            setRemotePeer({ id: 'remote-peer', name: 'Remote Peer', mode: 'remote', status: 'available' });
            // Only the initiator sends the WebRTC offer
            if (isInitiatorRef.current && p2pRef.current) {
              const offer = await p2pRef.current.initiateSender((candidate) => {
                ws.send(JSON.stringify({ type: 'ice', candidate }));
              });
              ws.send(JSON.stringify({ type: 'offer', sdp: offer }));
            }
            break;
          case 'offer':
            if (p2pRef.current && !isInitiatorRef.current) {
              const answer = await p2pRef.current.initiateReceiver(msg.sdp, (candidate) => {
                ws.send(JSON.stringify({ type: 'ice', candidate }));
              });
              ws.send(JSON.stringify({ type: 'answer', sdp: answer }));
            }
            break;
          case 'answer':
            if (isInitiatorRef.current) {
              await p2pRef.current?.setRemoteDescription(msg.sdp);
            }
            break;
          case 'ice':
            await p2pRef.current?.addIceCandidate(msg.candidate);
            break;
          case 'peer_left':
            setRemotePeer(null);
            p2pRef.current?.close();
            p2pRef.current = null;
            break;
          case 'error':
            console.error('[Signaling] Error:', msg.message);
            setLastError(msg.message);
            break;
        }
      } catch (err) {
        console.error('[Signaling] Message error', err);
      }
    };

    ws.onclose = () => console.log('[Signaling] Disconnected');
    return ws;
  }, []);

  const initP2P = useCallback(() => {
    p2pRef.current?.close();
    resetCrypto();

    const p2p = new P2PConnection(STUN_SERVERS);
    p2pRef.current = p2p;

    p2p.onChannelState(async (state) => {
      if (state === 'open') {
        setRemotePeer({ id: 'remote-peer', name: 'Connected Peer', mode: 'remote', status: 'available' });
        await startKeyExchange();
      } else if (state === 'closed') {
        setRemotePeer(null);
        sharedKeyRef.current = null;
      }
    });

    p2p.onData(async (data) => {
      if (typeof data === 'string') {
        let meta: Record<string, unknown>;
        try { meta = JSON.parse(data); } catch { return; }

        if (meta.type === 'ecdh_hello') {
          await finishKeyExchange(meta.publicKey as string);
          return;
        }

        if (meta.type === 'transfer_offer') {
          const transfer: Transfer = {
            id: meta.transferId as string,
            peerId: 'remote-peer',
            peerName: 'Connected Peer',
            direction: 'receive',
            fileName: meta.fileName as string,
            fileSize: meta.fileSize as number,
            totalChunks: meta.totalChunks as number,
            chunksReceived: 0,
            state: 'pending',
          };
          setIncomingTransfer(transfer);
          setTransfers((prev) => new Map(prev).set(meta.transferId as string, transfer));
          return;
        }

        if (meta.type === 'transfer_decision') {
          const { transferId, accepted } = meta as { transferId: string; accepted: boolean };
          setTransfers((prev) => {
            const next = new Map(prev);
            const t = next.get(transferId);
            if (t) next.set(transferId, {
              ...t,
              state: accepted ? 'transferring' : 'rejected',
              errorMessage: accepted ? undefined : 'Rejected by peer',
            });
            return next;
          });
          if (accepted) {
            const file = pendingSendsRef.current.get(transferId);
            if (file) {
              pendingSendsRef.current.delete(transferId);
              streamChunks(transferId, file);
            }
          } else {
            pendingSendsRef.current.delete(transferId);
          }
          return;
        }

        if (meta.type === 'send_file_start') {
          const storeKey = `${IDB_KEY_PREFIX}${meta.transferId as string}`;
          receiveMetaRef.current = {
            fileName: meta.fileName as string,
            fileSize: meta.fileSize as number,
            totalChunks: meta.totalChunks as number,
            chunksReceived: 0,
            transferId: meta.transferId as string,
            storeKey,
            expectedHash: null,
          };
          setTransfers((prev) => {
            const next = new Map(prev);
            const t = next.get(meta.transferId as string);
            if (t) next.set(meta.transferId as string, { ...t, state: 'transferring' });
            return next;
          });
          return;
        }

        if (meta.type === 'send_file_end') {
          const rm = receiveMetaRef.current;
          if (!rm) return;

          // Read each chunk back in index order from IDB rather than holding
          // the whole file in a JS array.
          const parts: ArrayBuffer[] = [];
          for (let i = 0; i < rm.totalChunks; i++) {
            const chunk = await idbGet<ArrayBuffer>(chunkKey(rm.storeKey, i));
            if (!chunk) {
              console.error(`[Receive] Missing IDB chunk ${i} for ${rm.fileName}`);
              setTransfers((prev) => {
                const next = new Map(prev);
                const t = next.get(rm.transferId);
                if (t) next.set(rm.transferId, { ...t, state: 'error', errorMessage: 'Reassembly failed — missing chunk' });
                return next;
              });
              await cleanupIdb(rm.storeKey, rm.totalChunks);
              receiveMetaRef.current = null;
              return;
            }
            parts.push(chunk);
          }

          const fileBuffer = await new Blob(parts).arrayBuffer();
          const actualHash = await sha256Hex(fileBuffer);
          const expectedHash = meta.sha256 as string | undefined;

          // End-to-end integrity check — catches reassembly bugs even when
          // every individual chunk decrypted successfully.
          if (expectedHash && actualHash !== expectedHash) {
            console.error(`[Crypto] Integrity FAILED — expected ${expectedHash}, got ${actualHash}`);
            setTransfers((prev) => {
              const next = new Map(prev);
              const t = next.get(rm.transferId);
              if (t) next.set(rm.transferId, { ...t, state: 'error', errorMessage: 'File integrity check failed' });
              return next;
            });
            await cleanupIdb(rm.storeKey, rm.totalChunks);
            receiveMetaRef.current = null;
            return;
          }

          // Cancel any stale revoke timer for this transferId before creating
          // a new ObjectURL — prevents the old timer from revoking the new URL.
          const existingTimer = revokeTimersRef.current.get(rm.transferId);
          if (existingTimer) clearTimeout(existingTimer);

          const blob = new Blob([fileBuffer]);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = rm.fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          const timerId = setTimeout(() => {
            URL.revokeObjectURL(url);
            revokeTimersRef.current.delete(rm.transferId);
          }, 1000);
          revokeTimersRef.current.set(rm.transferId, timerId);

          setTransfers((prev) => {
            const next = new Map(prev);
            const t = next.get(rm.transferId);
            if (t) next.set(rm.transferId, { ...t, state: 'completed', completedAt: Date.now() });
            return next;
          });

          await cleanupIdb(rm.storeKey, rm.totalChunks);
          receiveMetaRef.current = null;
          return;
        }
      }

      if (data instanceof ArrayBuffer) {
        const rm = receiveMetaRef.current;
        if (!rm) return;

        // Block until ECDH is complete — awaiting an already-resolved Promise
        // is nearly free (microtask hop).
        await keyReadyPromiseRef.current;

        if (keyDerivationFailedRef.current || !sharedKeyRef.current) {
          console.error('[Crypto] Key exchange failed — aborting transfer');
          setTransfers((prev) => {
            const next = new Map(prev);
            const t = next.get(rm.transferId);
            if (t) next.set(rm.transferId, { ...t, state: 'error', errorMessage: 'Key exchange failed' });
            return next;
          });
          p2pRef.current?.close();
          p2pRef.current = null;
          await cleanupIdb(rm.storeKey, rm.totalChunks);
          receiveMetaRef.current = null;
          return;
        }

        let plaintext: ArrayBuffer;
        try {
          plaintext = await decryptChunk(sharedKeyRef.current, data);
        } catch (err) {
          console.error('[Crypto] Decryption failed:', err);
          // Abort on first decrypt failure — continuing would produce silently
          // corrupted output.
          setTransfers((prev) => {
            const next = new Map(prev);
            const t = next.get(rm.transferId);
            if (t) next.set(rm.transferId, { ...t, state: 'error', errorMessage: 'Decryption failed — transfer aborted' });
            return next;
          });
          setLastError('Decryption failed — transfer may have been tampered with');
          p2pRef.current?.close();
          p2pRef.current = null;
          await cleanupIdb(rm.storeKey, rm.totalChunks);
          receiveMetaRef.current = null;
          return;
        }

        // Write to IDB immediately so only one 256 KB buffer (the current
        // chunk) lives in memory regardless of total file size.
        await idbSet(chunkKey(rm.storeKey, rm.chunksReceived), plaintext);
        rm.chunksReceived++;

        // Throttle setState to every 10 chunks (or final) so large files
        // don't drown React in renders.
        if (rm.chunksReceived % 10 === 0 || rm.chunksReceived === rm.totalChunks) {
          setTransfers((prev) => {
            const next = new Map(prev);
            const t = next.get(rm.transferId);
            if (t) next.set(rm.transferId, { ...t, chunksReceived: rm.chunksReceived });
            return next;
          });
        }
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const createRoom = useCallback(() => {
    isInitiatorRef.current = true;
    initP2P();
    const ws = connectSignaling();
    const sendCreate = () => ws.send(JSON.stringify({ type: 'create' }));
    ws.readyState === WebSocket.OPEN
      ? sendCreate()
      : ws.addEventListener('open', sendCreate, { once: true });
  }, [connectSignaling, initP2P]);

  const joinRoom = useCallback((code: string) => {
    isInitiatorRef.current = false;
    // Clear the share code shown in the UI from the auto-created room we're
    // about to abandon; it would be misleading after we join the peer's room.
    setShareCode(null);
    initP2P();
    // Force a fresh WS — leaves the auto-created room on the server side so
    // the join doesn't bounce with "Already in a room".
    const ws = connectSignaling(true);
    const sendJoin = () => ws.send(JSON.stringify({ type: 'join', roomId: code }));
    ws.readyState === WebSocket.OPEN
      ? sendJoin()
      : ws.addEventListener('open', sendJoin, { once: true });
  }, [connectSignaling, initP2P]);

  // Cancels pending ObjectURL revoke timers so they don't fire setState on
  // an unmounted component.
  const disconnect = useCallback(() => {
    for (const [, timerId] of revokeTimersRef.current) {
      clearTimeout(timerId);
    }
    revokeTimersRef.current.clear();

    p2pRef.current?.close();
    p2pRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    sharedKeyRef.current = null;
    keyPairRef.current = null;
    setShareCode(null);
    setRemotePeer(null);
    setIncomingTransfer(null);
  }, []);

  useEffect(() => {
    void gcOrphanedReceiveChunks();
    return () => { disconnect(); };
  }, [disconnect]);

  const sendRemoteFile = useCallback(async (file: File) => {
    if (!p2pRef.current || p2pRef.current.connectionState !== 'connected') {
      const msg = 'Not connected to a remote peer';
      console.error('[Remote]', msg);
      setLastError(msg);
      return;
    }

    // Read the cap from agentSocket per call so a backend MAX_FILE_SIZE bump
    // takes effect without a frontend rebuild.
    const maxFileSize = agentSocket.maxAcceptedFileSize || FALLBACK_MAX_FILE_SIZE;
    if (file.size > maxFileSize) {
      const msg = `File "${file.name}" (${file.size} bytes) exceeds the maximum allowed size of ${maxFileSize} bytes`;
      console.error('[Remote]', msg);
      setLastError(msg);
      return;
    }

    // Offer must travel over the encrypted channel
    await keyReadyPromiseRef.current;

    const transferId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    setTransfers((prev) => new Map(prev).set(transferId, {
      id: transferId,
      peerId: 'remote-peer',
      peerName: 'Connected Peer',
      direction: 'send',
      fileName: file.name,
      fileSize: file.size,
      totalChunks,
      chunksReceived: 0,
      state: 'pending',
    }));

    pendingSendsRef.current.set(transferId, file);

    try {
      await p2pRef.current.sendRaw(
        JSON.stringify({ type: 'transfer_offer', transferId, fileName: file.name, fileSize: file.size, totalChunks }),
      );
    } catch (e) {
      console.error('[Remote] Offer failed', e);
      setTransfers((prev) => {
        const next = new Map(prev);
        const t = next.get(transferId);
        if (t) next.set(transferId, { ...t, state: 'error', errorMessage: 'Failed to send transfer offer' });
        return next;
      });
      setLastError('Failed to send transfer offer');
    }
  }, []);

  async function streamChunks(transferId: string, file: File): Promise<void> {
    const p2p = p2pRef.current;
    const key = sharedKeyRef.current;
    if (!p2p || p2p.connectionState !== 'connected' || !key) {
      console.error('[Remote] Cannot stream: not connected or no key');
      return;
    }

    const fileHash = await sha256Hex(await file.arrayBuffer());
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    try {
      await p2p.sendRaw(
        JSON.stringify({ type: 'send_file_start', transferId, fileName: file.name, fileSize: file.size, totalChunks }),
      );

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        // file.slice() reads only 256 KB per iteration — avoids holding the
        // full file in memory.
        const slice = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
        const plaintext = await slice.arrayBuffer();
        await p2p.sendRaw(await encryptChunk(key, plaintext));

        if ((i + 1) % 10 === 0 || i + 1 === totalChunks) {
          setTransfers((prev) => {
            const next = new Map(prev);
            const t = next.get(transferId);
            if (t) next.set(transferId, { ...t, chunksReceived: i + 1 });
            return next;
          });
        }
      }

      await p2p.sendRaw(JSON.stringify({ type: 'send_file_end', transferId, sha256: fileHash }));
      setTransfers((prev) => {
        const next = new Map(prev);
        const t = next.get(transferId);
        if (t) next.set(transferId, { ...t, state: 'completed', completedAt: Date.now() });
        return next;
      });
    } catch (e) {
      console.error('[Remote] Stream failed', e);
      setTransfers((prev) => {
        const next = new Map(prev);
        const t = next.get(transferId);
        if (t) next.set(transferId, { ...t, state: 'error', errorMessage: 'Stream failed' });
        return next;
      });
      setLastError('File stream failed — the connection may have dropped');
    }
  }

  const acceptRemoteTransfer = useCallback(async (transferId: string) => {
    setIncomingTransfer(null);
    try {
      await p2pRef.current?.sendRaw(
        JSON.stringify({ type: 'transfer_decision', transferId, accepted: true }),
      );
    } catch (err) {
      console.error('[Remote] Accept failed', err);
      setLastError('Failed to send accept decision');
    }
  }, []);

  const rejectRemoteTransfer = useCallback(async (transferId: string) => {
    setIncomingTransfer(null);
    try {
      await p2pRef.current?.sendRaw(
        JSON.stringify({ type: 'transfer_decision', transferId, accepted: false }),
      );
      setTransfers((prev) => {
        const next = new Map(prev);
        const t = next.get(transferId);
        if (t) next.set(transferId, { ...t, state: 'rejected' });
        return next;
      });
    } catch (err) {
      console.error('[Remote] Reject failed', err);
      setLastError('Failed to send reject decision');
    }
  }, []);

  const dismissIncoming = useCallback(() => setIncomingTransfer(null), []);

  return {
    shareCode,
    remotePeer,
    transfers,
    incomingTransfer,
    lastError,
    createRoom,
    joinRoom,
    sendRemoteFile,
    acceptRemoteTransfer,
    rejectRemoteTransfer,
    dismissIncoming,
    disconnect,
  };
}
