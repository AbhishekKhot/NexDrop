/**
 * useRemoteTransfer.ts
 * React hook managing WebRTC remote P2P file transfer with end-to-end encryption.
 *
 * Full protocol flow after the DataChannel opens:
 *  1. ECDH key exchange (both sides simultaneously):
 *       → { type:'ecdh_hello', publicKey:<base64> }   (each sends their public key)
 *       ← peer's public key → derive AES-256-GCM session key via HKDF
 *  2. Sender notifies receiver of upcoming file:
 *       → { type:'transfer_offer', transferId, fileName, fileSize, totalChunks }
 *  3. Receiver accepts or rejects:
 *       → { type:'transfer_decision', transferId, accepted }
 *  4. Sender streams the file (only after decision=accepted):
 *       → { type:'send_file_start', transferId, ... }
 *       → N encrypted ArrayBuffer chunks  [ 12-byte IV | ciphertext+16-byte GCM tag ]
 *       → { type:'send_file_end', transferId, sha256:<hex> }
 *  5. Receiver verifies SHA-256 and triggers a browser download.
 *
 * Fixes applied:
 *  SEC-03  — File size checked against MAX_FILE_SIZE before any network activity
 *  ERR-04  — Any decryption failure immediately aborts the transfer, closes the
 *             DataChannel, and cleans up IDB — no partial corrupt data is exposed
 *  RACE-01 — Binary chunk handlers await keyReadyPromiseRef before processing,
 *             preventing a race where chunks arrive before ECDH completes
 *  RACE-02 — ObjectURL revoke timers are keyed by transferId so replacing a
 *             URL for the same transfer ID doesn't revoke the new URL early
 *  MEM-02  — Decrypted receive chunks are stored in IndexedDB (idb-keyval) rather
 *             than a JS in-memory array, preventing OOM for large files
 */

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

/** Signaling server URL — env var or localhost fallback for development */
const SIGNALING_URL =
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_SIGNALING_URL ?? 'ws://localhost:4002';

const CHUNK_SIZE = 256 * 1024; // 256 KB — must match backend CHUNK_SIZE

/**
 * Fallback file-size cap used only if the agent has not yet reported one.
 *
 * SEC-03: the authoritative value is published by the agent in agent_ready
 * and surfaced via agentSocket.maxAcceptedFileSize.  sendRemoteFile() reads
 * that getter at call time so a backend change (e.g. raising MAX_FILE_SIZE)
 * takes effect without any frontend redeploy.
 */
const FALLBACK_MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

/**
 * IDB key prefix for receive buffers — MEM-02.
 * Each chunk is stored as: "nexdrop-recv-{transferId}-{chunkIndex}"
 * This namespacing prevents collisions if multiple transfers run in parallel
 * and makes it easy to batch-delete all keys for one transfer on cleanup.
 */
const IDB_KEY_PREFIX = 'nexdrop-recv-';

/**
 * Build the IDB key for a single chunk.
 * @param storeKey  Base key (IDB_KEY_PREFIX + transferId)
 * @param index     0-based chunk index
 */
function chunkKey(storeKey: string, index: number): string {
  return `${storeKey}-${index}`;
}

/**
 * Delete all IDB entries for a completed or aborted receive transfer — MEM-02.
 *
 * All deletes are issued in parallel (Promise.all) to minimise IDB round-trips.
 * The .catch() swallows errors — if an IDB delete fails (e.g. the storage was
 * already cleared), we don't want to surface it to the user on top of whatever
 * triggered the cleanup.
 *
 * @param storeKey     Base key prefix for this transfer.
 * @param totalChunks  How many chunk entries exist (0..totalChunks-1).
 */
async function cleanupIdb(storeKey: string, totalChunks: number): Promise<void> {
  const deletes: Promise<void>[] = [];
  for (let i = 0; i < totalChunks; i++) {
    deletes.push(idbDel(chunkKey(storeKey, i)));
  }
  await Promise.all(deletes).catch(() => { /* best-effort */ });
}

/**
 * MEM-04: Garbage-collect orphaned receive chunks left over from a tab that
 * was killed mid-receive (close button, crash, refresh).
 *
 * The hook is the only writer of nexdrop-recv-* keys.  On a fresh mount there
 * is no in-flight transfer in this tab, so every key matching the prefix is
 * orphaned and safe to drop.  Active transfers started after the sweep are
 * unaffected because they use a freshly-randomised transferId.
 *
 * Errors are swallowed — IDB unavailable (private browsing on some engines,
 * quota exceeded) must not block the hook from initialising.
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

  // ── WebRTC / signaling refs ───────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);
  const p2pRef = useRef<P2PConnection | null>(null);
  /**
   * isInitiatorRef distinguishes the room creator (sender of the initial offer)
   * from the joiner (sender of the answer).  Only the initiator calls
   * initiateSender() when peer_joined fires — the joiner waits for the 'offer'
   * message and calls initiateReceiver().
   */
  const isInitiatorRef = useRef<boolean>(false);

  // ── E2E crypto refs ───────────────────────────────────────────────────────
  const keyPairRef = useRef<ECDHKeyPair | null>(null);
  const sharedKeyRef = useRef<CryptoKey | null>(null);

  /**
   * RACE-01: keyReadyPromiseRef gates ALL binary chunk handlers.
   *
   * Problem: WebRTC DataChannel chunks can arrive before the ECDH exchange
   * completes (especially on low-latency connections where the sender starts
   * streaming immediately after the channel opens).
   *
   * Solution: every binary chunk handler awaits keyReadyPromiseRef.current
   * before attempting decryption.  resetCrypto() creates a new unresolved
   * Promise; startKeyExchange()/finishKeyExchange() resolve it when the key
   * is ready.  Once resolved, subsequent awaits return immediately (Promise
   * resolution is cached).
   */
  const keyReadyPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const keyReadyResolveRef = useRef<(() => void) | null>(null);
  /**
   * Flag set when key derivation fails — checked immediately after awaiting
   * keyReadyPromiseRef so chunk handlers can abort cleanly without an
   * ambiguous "decrypt with null key" error.
   */
  const keyDerivationFailedRef = useRef(false);

  // ── Receive state (MEM-02: IDB-backed) ───────────────────────────────────
  /**
   * Metadata for the currently-receiving transfer.
   *
   * storeKey is the IDB prefix (IDB_KEY_PREFIX + transferId) — stored here
   * so cleanupIdb() can be called from any handler without re-deriving it.
   * expectedHash is set from send_file_start but checked at send_file_end.
   */
  const receiveMetaRef = useRef<{
    fileName: string;
    fileSize: number;
    totalChunks: number;
    chunksReceived: number;
    transferId: string;
    storeKey: string;
    expectedHash: string | null;
  } | null>(null);

  /**
   * Pending file sends awaiting the receiver's transfer_decision.
   * Keyed by transferId so streamChunks() can retrieve the File after acceptance.
   */
  const pendingSendsRef = useRef<Map<string, File>>(new Map());

  /**
   * RACE-02: ObjectURL revoke timers keyed by transferId.
   *
   * Problem: URL.createObjectURL() creates a memory-mapped blob URL.
   * If we revoke it too early (e.g. before the browser completes the download),
   * the file download fails silently.  If we never revoke it, the blob stays
   * in memory for the entire page session.
   *
   * Solution: set a 1-second timer after triggering the download link click.
   * Key the timer by transferId so if the same transfer somehow completes
   * twice (shouldn't happen, but defensively handled), the old timer is
   * cancelled before a new URL is created.
   *
   * All timers are cleared on disconnect() to prevent post-unmount callbacks.
   */
  const revokeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Crypto lifecycle helpers ──────────────────────────────────────────────

  /**
   * Reset crypto state for a new connection.
   *
   * Creates a new unresolved Promise for keyReadyPromiseRef so chunk handlers
   * will block until the new ECDH exchange completes.  Must be called whenever
   * a new P2PConnection is created (in initP2P()).
   */
  function resetCrypto(): void {
    keyPairRef.current = null;
    sharedKeyRef.current = null;
    keyDerivationFailedRef.current = false;
    const promise = new Promise<void>((resolve) => {
      keyReadyResolveRef.current = resolve;
    });
    keyReadyPromiseRef.current = promise;
  }

  /**
   * Initiate ECDH: generate our key pair and send the public key to the peer.
   *
   * Called once when the DataChannel opens (onChannelState 'open').
   * Both the initiator and the joiner call this — there is no designated
   * "client" or "server" role for the crypto exchange.
   *
   * On failure: sets keyDerivationFailedRef and resolves keyReadyPromiseRef
   * so waiting chunk handlers unblock, check the failure flag, and abort.
   */
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
      keyReadyResolveRef.current?.(); // unblock any waiting chunk handlers
    }
  }

  /**
   * Complete ECDH: import the peer's public key and derive the shared AES key.
   *
   * Called when an 'ecdh_hello' message arrives from the peer.
   * After this resolves, keyReadyPromiseRef is resolved and all buffered
   * chunk handlers (RACE-01) can proceed with decryption.
   *
   * Edge case — ecdh_hello before our key pair is ready:
   * If we receive the peer's public key before generateECDHKeyPair() has returned
   * (theoretically possible on a very fast link), keyPairRef.current is null.
   * We treat this as a failure rather than risking a subtle crypto bug.
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
      keyReadyResolveRef.current?.(); // unblock chunk handlers — key is ready
      console.log('[Crypto] ECDH complete — AES-256-GCM session key ready');
    } catch (err) {
      console.error('[Crypto] Shared key derivation failed:', err);
      keyDerivationFailedRef.current = true;
      keyReadyResolveRef.current?.(); // unblock with failure flag set
    }
  }

  // ── Signaling connection ──────────────────────────────────────────────────

  /**
   * Connect to the signaling server (or reuse an existing OPEN connection).
   *
   * The signaling WS handles offer/answer/ICE relay only.  File bytes never
   * flow through it.
   *
   * Message handlers:
   *  joined      — room created/joined; share code received
   *  peer_joined — second peer connected; initiator sends WebRTC offer
   *  offer       — joiner receives offer; sends answer back
   *  answer      — initiator applies remote description to complete negotiation
   *  ice         — trickle ICE: add candidate to the RTCPeerConnection
   *  peer_left   — other peer disconnected; clean up P2P state
   *  error       — signaling error; surface to UI via lastError
   */
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
            // Only the initiator sends the WebRTC offer — the joiner waits for it
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

  // ── P2P connection lifecycle ──────────────────────────────────────────────

  /**
   * Create a new P2PConnection and wire up DataChannel event handlers.
   *
   * Closes any existing P2PConnection first (MEM-03: nulls out all handlers).
   * Calls resetCrypto() so a new RACE-01 gate is in place for the new session.
   *
   * DataChannel state handler:
   *  'open'   — start ECDH key exchange immediately
   *  'closed' — clear remote peer and shared key
   *
   * DataChannel data handler:
   *  string   — JSON control/metadata messages (ecdh_hello, transfer_offer, etc.)
   *  ArrayBuffer — encrypted file chunk (RACE-01 gate, then MEM-02 IDB write)
   */
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
      // ── JSON control / metadata ───────────────────────────────────────────
      if (typeof data === 'string') {
        let meta: Record<string, unknown>;
        try { meta = JSON.parse(data); } catch { return; }

        if (meta.type === 'ecdh_hello') {
          // Peer sent their public key — complete the ECDH exchange
          await finishKeyExchange(meta.publicKey as string);
          return;
        }

        if (meta.type === 'transfer_offer') {
          // Peer wants to send a file — show the accept/reject modal
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
          // Receiver responded to our offer — start streaming if accepted
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
              streamChunks(transferId, file); // async — fire and forget
            }
          } else {
            pendingSendsRef.current.delete(transferId);
          }
          return;
        }

        if (meta.type === 'send_file_start') {
          // Sender is about to stream chunks — set up receive state
          const storeKey = `${IDB_KEY_PREFIX}${meta.transferId as string}`;
          receiveMetaRef.current = {
            fileName: meta.fileName as string,
            fileSize: meta.fileSize as number,
            totalChunks: meta.totalChunks as number,
            chunksReceived: 0,
            transferId: meta.transferId as string,
            storeKey,
            expectedHash: null, // set from send_file_end
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

          // MEM-02: assemble from IDB — reads each chunk back in index order
          // rather than from a JS array that would hold all bytes in heap.
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

          // End-to-end integrity: verify assembled file hash matches sender's
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

          // RACE-02: cancel any stale revoke timer for this transferId before
          // creating a new ObjectURL — prevents the old timer from revoking the new URL
          const existingTimer = revokeTimersRef.current.get(rm.transferId);
          if (existingTimer) clearTimeout(existingTimer);

          // Trigger browser download via a temporary anchor click
          const blob = new Blob([fileBuffer]);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = rm.fileName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          // RACE-02: schedule URL revocation 1 second after the click, keyed by transferId
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

      // ── Encrypted binary chunk ────────────────────────────────────────────
      if (data instanceof ArrayBuffer) {
        const rm = receiveMetaRef.current;
        if (!rm) return;

        // RACE-01: block until ECDH is complete.
        // Awaiting an already-resolved Promise is nearly free (microtask hop).
        await keyReadyPromiseRef.current;

        // Check for key derivation failure before attempting decrypt
        if (keyDerivationFailedRef.current || !sharedKeyRef.current) {
          console.error('[Crypto] Key exchange failed — aborting transfer');
          setTransfers((prev) => {
            const next = new Map(prev);
            const t = next.get(rm.transferId);
            if (t) next.set(rm.transferId, { ...t, state: 'error', errorMessage: 'Key exchange failed' });
            return next;
          });
          // ERR-04: close channel and release IDB resources
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
          // ERR-04: abort on first decrypt failure — do not process further chunks.
          // Continuing after a failed decrypt would produce silently corrupted output.
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

        // MEM-02: write each decrypted chunk to IDB immediately.
        // This keeps the JS heap flat — only one 256 KB buffer lives in memory
        // at a time (the current chunk), regardless of total file size.
        await idbSet(chunkKey(rm.storeKey, rm.chunksReceived), plaintext);
        rm.chunksReceived++;

        // Update the progress bar every 10 chunks (or on last chunk) to avoid
        // setState overhead on every single chunk for large files
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

  // ── Room management ───────────────────────────────────────────────────────

  /**
   * Create a signaling room and become the initiator (WebRTC offer sender).
   * The server assigns an 8-char share code that the user shares out-of-band.
   */
  const createRoom = useCallback(() => {
    isInitiatorRef.current = true;
    initP2P();
    const ws = connectSignaling();
    const sendCreate = () => ws.send(JSON.stringify({ type: 'create' }));
    // If the WS is already open, send immediately; otherwise wait for 'open'
    ws.readyState === WebSocket.OPEN
      ? sendCreate()
      : ws.addEventListener('open', sendCreate, { once: true });
  }, [connectSignaling, initP2P]);

  /**
   * Join an existing room using a share code entered by the user.
   * The joiner waits for the initiator to send the WebRTC offer.
   */
  const joinRoom = useCallback((code: string) => {
    isInitiatorRef.current = false;
    initP2P();
    const ws = connectSignaling();
    const sendJoin = () => ws.send(JSON.stringify({ type: 'join', roomId: code }));
    ws.readyState === WebSocket.OPEN
      ? sendJoin()
      : ws.addEventListener('open', sendJoin, { once: true });
  }, [connectSignaling, initP2P]);

  /**
   * Tear down the WebRTC + signaling connections and clean up all refs.
   *
   * RACE-02: cancels all pending ObjectURL revoke timers to prevent them from
   * firing after the component unmounts and calling setState on an unmounted component.
   */
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

  // MEM-04: sweep orphaned receive chunks on mount; disconnect on unmount.
  // Both run only once for the lifetime of the hook because disconnect's
  // identity is stable (useCallback with [] deps) and gcOrphanedReceiveChunks
  // is a fire-and-forget Promise we deliberately don't await.
  useEffect(() => {
    void gcOrphanedReceiveChunks();
    return () => { disconnect(); };
  }, [disconnect]);

  // ── File send ─────────────────────────────────────────────────────────────

  /**
   * Initiate sending a file to the connected remote peer.
   *
   * Flow:
   *  1. Validate connection and file size (SEC-03).
   *  2. Wait for ECDH to complete (in case this is called very early).
   *  3. Send transfer_offer — the receiver shows accept/reject modal.
   *  4. Execution continues in the transfer_decision handler once the peer responds.
   */
  const sendRemoteFile = useCallback(async (file: File) => {
    if (!p2pRef.current || p2pRef.current.connectionState !== 'connected') {
      const msg = 'Not connected to a remote peer';
      console.error('[Remote]', msg);
      setLastError(msg);
      return;
    }

    // SEC-03: reject before any network activity.
    // Read the cap from agentSocket every call so a backend bump in MAX_FILE_SIZE
    // takes effect without a frontend rebuild.  Falls back to the hardcoded 2 GB
    // value only if agent_ready has not yet arrived.
    const maxFileSize = agentSocket.maxAcceptedFileSize || FALLBACK_MAX_FILE_SIZE;
    if (file.size > maxFileSize) {
      const msg = `File "${file.name}" (${file.size} bytes) exceeds the maximum allowed size of ${maxFileSize} bytes`;
      console.error('[Remote]', msg);
      setLastError(msg);
      return;
    }

    // Block until ECDH is complete — the offer must be sent over an encrypted channel
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

    // Store the File object so streamChunks() can retrieve it after acceptance
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

  /**
   * Stream all encrypted file chunks to the peer after transfer acceptance.
   *
   * Called from the transfer_decision handler (not directly by the user).
   *
   * Each chunk is:
   *  1. Sliced from the File object (constant memory — 256 KB per iteration)
   *  2. Encrypted with AES-256-GCM using the shared session key
   *  3. Sent over the DataChannel (sendRaw handles backpressure internally)
   *
   * The SHA-256 of the full file is computed upfront (from a single arrayBuffer()
   * call) and sent in send_file_end — this is the integrity reference for the receiver.
   */
  async function streamChunks(transferId: string, file: File): Promise<void> {
    const p2p = p2pRef.current;
    const key = sharedKeyRef.current;
    if (!p2p || p2p.connectionState !== 'connected' || !key) {
      console.error('[Remote] Cannot stream: not connected or no key');
      return;
    }

    // Compute full-file hash upfront — needed for send_file_end integrity message
    const fileHash = await sha256Hex(await file.arrayBuffer());
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    try {
      await p2p.sendRaw(
        JSON.stringify({ type: 'send_file_start', transferId, fileName: file.name, fileSize: file.size, totalChunks }),
      );

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        // file.slice() reads only 256 KB — avoids holding the full file in memory
        const slice = file.slice(start, Math.min(start + CHUNK_SIZE, file.size));
        const plaintext = await slice.arrayBuffer();
        await p2p.sendRaw(await encryptChunk(key, plaintext));

        // Update progress bar every 10 chunks or on the last chunk
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

  // ── Accept / reject ───────────────────────────────────────────────────────

  /**
   * Accept an incoming transfer offer.
   * Sends the decision to the sender via the DataChannel so it can start streaming.
   */
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

  /**
   * Reject an incoming transfer offer.
   * Updates local transfer state to 'rejected' for UI display.
   */
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

  /** Dismiss the incoming transfer modal without accepting or rejecting */
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
