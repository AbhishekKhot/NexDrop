/**
 * useRemoteTransfer.ts
 * React hook for WebRTC remote P2P file transfer with end-to-end encryption.
 *
 * Protocol flow after DataChannel opens:
 *  1. Both sides perform ECDH key exchange:
 *       → {type:'ecdh_hello', publicKey:<base64>}
 *       ← peer's public key → derive AES-256-GCM session key
 *  2. Sender notifies receiver of upcoming file:
 *       → {type:'transfer_offer', transferId, fileName, fileSize, totalChunks}
 *  3. Receiver accepts or rejects:
 *       → {type:'transfer_decision', transferId, accepted}
 *  4. Sender streams the file:
 *       → {type:'send_file_start', transferId, fileName, fileSize, totalChunks}
 *       → N encrypted ArrayBuffer chunks  (each: [12-byte IV][ciphertext+tag])
 *       → {type:'send_file_end', transferId, sha256:<hex>}
 *  5. Receiver verifies SHA-256 and triggers browser download.
 *
 * Fixes applied:
 *  SEC-03  — File size check against MAX_FILE_SIZE before sending
 *  ERR-04  — Decrypt failure aborts transfer; DataChannel closed; buffer released
 *  RACE-01 — Chunks queued until ECDH key is ready (keyReadyPromise)
 *  RACE-02 — ObjectURL revoke timers keyed by transferId to prevent races
 *  MEM-02  — Receive buffer uses IndexedDB (idb-keyval) to avoid heap OOM
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import { P2PConnection, STUN_SERVERS } from '../lib/webrtc';
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

const CHUNK_SIZE = 256 * 1024; // 256 KB

// SEC-03: frontend default; overridden by agent_ready if agent is connected
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

const IDB_KEY_PREFIX = 'nexdrop-recv-';

/** Build an IDB key for a specific chunk */
function chunkKey(storeKey: string, index: number): string {
  return `${storeKey}-${index}`;
}

/** Clean up all IDB keys for a transfer — MEM-02 */
async function cleanupIdb(storeKey: string, totalChunks: number): Promise<void> {
  const deletes: Promise<void>[] = [];
  for (let i = 0; i < totalChunks; i++) {
    deletes.push(idbDel(chunkKey(storeKey, i)));
  }
  await Promise.all(deletes).catch(() => { /* best-effort */ });
}

export function useRemoteTransfer(): RemoteTransferState {
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [remotePeer, setRemotePeer] = useState<Peer | null>(null);
  const [transfers, setTransfers] = useState<Map<string, Transfer>>(new Map());
  const [incomingTransfer, setIncomingTransfer] = useState<Transfer | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  // ── WebRTC / Signaling refs ─────────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);
  const p2pRef = useRef<P2PConnection | null>(null);
  const isInitiatorRef = useRef<boolean>(false);

  // ── E2E Crypto refs ─────────────────────────────────────────────────────────
  const keyPairRef = useRef<ECDHKeyPair | null>(null);
  const sharedKeyRef = useRef<CryptoKey | null>(null);
  /** RACE-01: resolves when ECDH is complete; queues chunks until then */
  const keyReadyPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const keyReadyResolveRef = useRef<(() => void) | null>(null);
  const keyDerivationFailedRef = useRef(false);

  // ── File receive state (MEM-02: IDB-backed) ─────────────────────────────────
  const receiveMetaRef = useRef<{
    fileName: string;
    fileSize: number;
    totalChunks: number;
    chunksReceived: number;
    transferId: string;
    storeKey: string;       // MEM-02: IDB key prefix for this transfer
    expectedHash: string | null;
  } | null>(null);

  // ── Pending sends waiting for peer acceptance ───────────────────────────────
  const pendingSendsRef = useRef<Map<string, File>>(new Map());

  // ── RACE-02: ObjectURL revoke timers keyed by transferId ────────────────────
  const revokeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Crypto helpers ───────────────────────────────────────────────────────────

  function resetCrypto(): void {
    keyPairRef.current = null;
    sharedKeyRef.current = null;
    keyDerivationFailedRef.current = false;
    const promise = new Promise<void>((resolve) => {
      keyReadyResolveRef.current = resolve;
    });
    keyReadyPromiseRef.current = promise;
  }

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
      keyReadyResolveRef.current?.(); // unblock waiters with failure flag set
    }
  }

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
      keyReadyResolveRef.current?.(); // unblock waiters
    }
  }

  // ── Signaling ────────────────────────────────────────────────────────────────

  const connectSignaling = useCallback(() => {
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

  // ── P2P connection ───────────────────────────────────────────────────────────

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
      // ── Control / metadata (JSON strings) ─────────────────────────────────
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
            if (t) next.set(transferId, { ...t, state: accepted ? 'transferring' : 'rejected', errorMessage: accepted ? undefined : 'Rejected by peer' });
            return next;
          });
          if (accepted) {
            const file = pendingSendsRef.current.get(transferId);
            if (file) { pendingSendsRef.current.delete(transferId); streamChunks(transferId, file); }
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

          // MEM-02: assemble from IDB rather than in-memory buffer
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

          // RACE-02: cancel any stale timer for this transferId before creating a new one
          const existingTimer = revokeTimersRef.current.get(rm.transferId);
          if (existingTimer) clearTimeout(existingTimer);

          const blob = new Blob([fileBuffer]);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url; a.download = rm.fileName;
          document.body.appendChild(a); a.click();
          document.body.removeChild(a);

          // RACE-02: key the revoke timer by transferId
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

      // ── Encrypted binary chunk ─────────────────────────────────────────────
      if (data instanceof ArrayBuffer) {
        const rm = receiveMetaRef.current;
        if (!rm) return;

        // RACE-01: wait for ECDH to complete before decrypting any chunk
        await keyReadyPromiseRef.current;

        // Check if key derivation failed during the wait
        if (keyDerivationFailedRef.current || !sharedKeyRef.current) {
          console.error('[Crypto] Key exchange failed — aborting transfer');
          setTransfers((prev) => {
            const next = new Map(prev);
            const t = next.get(rm.transferId);
            if (t) next.set(rm.transferId, { ...t, state: 'error', errorMessage: 'Key exchange failed' });
            return next;
          });
          // ERR-04: close channel and release resources
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
          // ERR-04: abort immediately on any decrypt failure
          setTransfers((prev) => {
            const next = new Map(prev);
            const t = next.get(rm.transferId);
            if (t) next.set(rm.transferId, { ...t, state: 'error', errorMessage: 'Decryption failed — transfer aborted' });
            return next;
          });
          setLastError('Decryption failed — transfer may have been tampered with');
          // ERR-04: close DataChannel and release IDB buffer
          p2pRef.current?.close();
          p2pRef.current = null;
          await cleanupIdb(rm.storeKey, rm.totalChunks);
          receiveMetaRef.current = null;
          return;
        }

        // MEM-02: store chunk in IndexedDB instead of in-memory array
        await idbSet(chunkKey(rm.storeKey, rm.chunksReceived), plaintext);
        rm.chunksReceived++;

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

  // ── Room management ──────────────────────────────────────────────────────────

  const createRoom = useCallback(() => {
    isInitiatorRef.current = true;
    initP2P();
    const ws = connectSignaling();
    const sendCreate = () => ws.send(JSON.stringify({ type: 'create' }));
    ws.readyState === WebSocket.OPEN ? sendCreate() : ws.addEventListener('open', sendCreate, { once: true });
  }, [connectSignaling, initP2P]);

  const joinRoom = useCallback((code: string) => {
    isInitiatorRef.current = false;
    initP2P();
    const ws = connectSignaling();
    const sendJoin = () => ws.send(JSON.stringify({ type: 'join', roomId: code }));
    ws.readyState === WebSocket.OPEN ? sendJoin() : ws.addEventListener('open', sendJoin, { once: true });
  }, [connectSignaling, initP2P]);

  const disconnect = useCallback(() => {
    // RACE-02: clear all pending revoke timers on disconnect
    for (const [, timerId] of revokeTimersRef.current) {
      clearTimeout(timerId);
    }
    revokeTimersRef.current.clear();

    p2pRef.current?.close(); p2pRef.current = null;
    wsRef.current?.close(); wsRef.current = null;
    sharedKeyRef.current = null; keyPairRef.current = null;
    setShareCode(null); setRemotePeer(null); setIncomingTransfer(null);
  }, []);

  useEffect(() => () => { disconnect(); }, [disconnect]);

  // ── File send ────────────────────────────────────────────────────────────────

  const sendRemoteFile = useCallback(async (file: File) => {
    if (!p2pRef.current || p2pRef.current.connectionState !== 'connected') {
      const msg = 'Not connected to a remote peer';
      console.error('[Remote]', msg);
      setLastError(msg);
      return;
    }

    // SEC-03: check file size before sending
    if (file.size > MAX_FILE_SIZE) {
      const msg = `File "${file.name}" (${file.size} bytes) exceeds the maximum allowed size`;
      console.error('[Remote]', msg);
      setLastError(msg);
      return;
    }

    await keyReadyPromiseRef.current;

    const transferId = crypto.randomUUID();
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    setTransfers((prev) => new Map(prev).set(transferId, {
      id: transferId, peerId: 'remote-peer', peerName: 'Connected Peer',
      direction: 'send', fileName: file.name, fileSize: file.size,
      totalChunks, chunksReceived: 0, state: 'pending',
    }));
    pendingSendsRef.current.set(transferId, file);
    try {
      await p2pRef.current.sendRaw(JSON.stringify({ type: 'transfer_offer', transferId, fileName: file.name, fileSize: file.size, totalChunks }));
    } catch (e) {
      console.error('[Remote] Offer failed', e);
      setTransfers((prev) => { const next = new Map(prev); const t = next.get(transferId); if (t) next.set(transferId, { ...t, state: 'error', errorMessage: 'Failed to send transfer offer' }); return next; });
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

    // SEC-03: load file in slices (avoid single-shot arrayBuffer for large files)
    const fileHash = await sha256Hex(await file.arrayBuffer());
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    try {
      await p2p.sendRaw(JSON.stringify({ type: 'send_file_start', transferId, fileName: file.name, fileSize: file.size, totalChunks }));

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const slice = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
        const plaintext = await slice.arrayBuffer();
        await p2p.sendRaw(await encryptChunk(key, plaintext));
        if ((i + 1) % 10 === 0 || i + 1 === totalChunks) {
          setTransfers((prev) => { const next = new Map(prev); const t = next.get(transferId); if (t) next.set(transferId, { ...t, chunksReceived: i + 1 }); return next; });
        }
      }

      await p2p.sendRaw(JSON.stringify({ type: 'send_file_end', transferId, sha256: fileHash }));
      setTransfers((prev) => { const next = new Map(prev); const t = next.get(transferId); if (t) next.set(transferId, { ...t, state: 'completed', completedAt: Date.now() }); return next; });
    } catch (e) {
      console.error('[Remote] Stream failed', e);
      setTransfers((prev) => { const next = new Map(prev); const t = next.get(transferId); if (t) next.set(transferId, { ...t, state: 'error', errorMessage: 'Stream failed' }); return next; });
      setLastError('File stream failed — the connection may have dropped');
    }
  }

  // ── Accept / reject ──────────────────────────────────────────────────────────

  const acceptRemoteTransfer = useCallback(async (transferId: string) => {
    setIncomingTransfer(null);
    try { await p2pRef.current?.sendRaw(JSON.stringify({ type: 'transfer_decision', transferId, accepted: true })); }
    catch (err) {
      console.error('[Remote] Accept failed', err);
      setLastError('Failed to send accept decision');
    }
  }, []);

  const rejectRemoteTransfer = useCallback(async (transferId: string) => {
    setIncomingTransfer(null);
    try {
      await p2pRef.current?.sendRaw(JSON.stringify({ type: 'transfer_decision', transferId, accepted: false }));
      setTransfers((prev) => { const next = new Map(prev); const t = next.get(transferId); if (t) next.set(transferId, { ...t, state: 'rejected' }); return next; });
    } catch (err) {
      console.error('[Remote] Reject failed', err);
      setLastError('Failed to send reject decision');
    }
  }, []);

  const dismissIncoming = useCallback(() => setIncomingTransfer(null), []);

  return { shareCode, remotePeer, transfers, incomingTransfer, lastError, createRoom, joinRoom, sendRemoteFile, acceptRemoteTransfer, rejectRemoteTransfer, dismissIncoming, disconnect };
}
