/**
 * useRemoteTransfer.ts
 * React hook for WebRTC remote P2P file transfer with end-to-end encryption.
 *
 * Protocol flow after DataChannel opens:
 *  1. Both sides immediately perform an ECDH key exchange:
 *       → send {type:'ecdh_hello', publicKey:<base64>}
 *       ← receive peer's public key → derive shared AES-256-GCM session key
 *  2. Sender notifies receiver of upcoming file:
 *       → {type:'transfer_offer', transferId, fileName, fileSize, totalChunks}
 *  3. Receiver accepts or rejects:
 *       → {type:'transfer_decision', transferId, accepted}
 *  4. On acceptance, sender streams the file:
 *       → {type:'send_file_start', transferId, fileName, fileSize, totalChunks}
 *       → N encrypted ArrayBuffer chunks  (each: [12-byte IV][ciphertext+tag])
 *       → {type:'send_file_end', transferId, sha256:<hex>}
 *  5. Receiver verifies SHA-256 and triggers browser download.
 *
 * Security:
 *  - ECDH P-256 → HKDF-SHA-256 → AES-256-GCM (128-bit auth tag)
 *  - New ephemeral key pair generated per P2P session
 *  - Full-file SHA-256 integrity check on receive
 */

import { useState, useEffect, useCallback, useRef } from 'react';
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
  createRoom: () => void;
  joinRoom: (code: string) => void;
  sendRemoteFile: (file: File) => void;
  acceptRemoteTransfer: (transferId: string) => void;
  rejectRemoteTransfer: (transferId: string) => void;
  dismissIncoming: () => void;
  disconnect: () => void;
}

const SIGNALING_URL =
  import.meta.env.VITE_SIGNALING_URL || 'ws://localhost:4002';

const CHUNK_SIZE = 256 * 1024; // 256 KB

export function useRemoteTransfer(): RemoteTransferState {
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [remotePeer, setRemotePeer] = useState<Peer | null>(null);
  const [transfers, setTransfers] = useState<Map<string, Transfer>>(new Map());
  const [incomingTransfer, setIncomingTransfer] = useState<Transfer | null>(null);

  // ── WebRTC / Signaling refs ─────────────────────────────────────────────────
  const wsRef = useRef<WebSocket | null>(null);
  const p2pRef = useRef<P2PConnection | null>(null);
  const isInitiatorRef = useRef<boolean>(false);

  // ── E2E Crypto refs ─────────────────────────────────────────────────────────
  const keyPairRef = useRef<ECDHKeyPair | null>(null);
  const sharedKeyRef = useRef<CryptoKey | null>(null);
  /** Resolves when ECDH is complete and sharedKeyRef is populated. */
  const keyReadyPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const keyReadyResolveRef = useRef<(() => void) | null>(null);

  // ── File receive state ──────────────────────────────────────────────────────
  const receiveBufferRef = useRef<ArrayBuffer[]>([]);
  const receiveMetaRef = useRef<{
    fileName: string;
    fileSize: number;
    totalChunks: number;
    chunksReceived: number;
    transferId: string;
    expectedHash: string | null;
  } | null>(null);

  // ── Pending sends waiting for peer acceptance ───────────────────────────────
  const pendingSendsRef = useRef<Map<string, File>>(new Map());

  // ── Crypto helpers ───────────────────────────────────────────────────────────

  function resetCrypto(): void {
    keyPairRef.current = null;
    sharedKeyRef.current = null;
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
    }
  }

  async function finishKeyExchange(b64RemotePubKey: string): Promise<void> {
    try {
      if (!keyPairRef.current) {
        console.error('[Crypto] Received ecdh_hello before our key pair was ready');
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
        // Kick off ECDH — both sides do this simultaneously on channel open
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
          receiveMetaRef.current = {
            fileName: meta.fileName as string,
            fileSize: meta.fileSize as number,
            totalChunks: meta.totalChunks as number,
            chunksReceived: 0,
            transferId: meta.transferId as string,
            expectedHash: null,
          };
          receiveBufferRef.current = [];
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

          const fileBuffer = await new Blob(receiveBufferRef.current).arrayBuffer();
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
            receiveMetaRef.current = null;
            receiveBufferRef.current = [];
            return;
          }

          const url = URL.createObjectURL(new Blob([fileBuffer]));
          const a = document.createElement('a');
          a.href = url; a.download = rm.fileName;
          document.body.appendChild(a); a.click();
          document.body.removeChild(a); URL.revokeObjectURL(url);

          setTransfers((prev) => {
            const next = new Map(prev);
            const t = next.get(rm.transferId);
            if (t) next.set(rm.transferId, { ...t, state: 'completed' });
            return next;
          });
          receiveMetaRef.current = null;
          receiveBufferRef.current = [];
          return;
        }
      }

      // ── Encrypted binary chunk ─────────────────────────────────────────────
      if (data instanceof ArrayBuffer) {
        const rm = receiveMetaRef.current;
        if (!rm) return;
        if (!sharedKeyRef.current) {
          console.error('[Crypto] Chunk before key exchange — dropping');
          return;
        }
        let plaintext: ArrayBuffer;
        try {
          plaintext = await decryptChunk(sharedKeyRef.current, data);
        } catch (err) {
          console.error('[Crypto] Decryption failed:', err);
          setTransfers((prev) => {
            const next = new Map(prev);
            const t = next.get(rm.transferId);
            if (t) next.set(rm.transferId, { ...t, state: 'error', errorMessage: 'Decryption failed' });
            return next;
          });
          return;
        }
        receiveBufferRef.current.push(plaintext);
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
    p2pRef.current?.close(); p2pRef.current = null;
    wsRef.current?.close(); wsRef.current = null;
    sharedKeyRef.current = null; keyPairRef.current = null;
    setShareCode(null); setRemotePeer(null); setIncomingTransfer(null);
  }, []);

  useEffect(() => () => { disconnect(); }, [disconnect]);

  // ── File send ────────────────────────────────────────────────────────────────

  const sendRemoteFile = useCallback(async (file: File) => {
    if (!p2pRef.current || p2pRef.current.connectionState !== 'connected') {
      console.error('[Remote] Not connected');
      return;
    }
    // Block until ECDH key exchange is done
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
      setTransfers((prev) => { const next = new Map(prev); const t = next.get(transferId); if (t) next.set(transferId, { ...t, state: 'error' }); return next; });
    }
  }, []);

  async function streamChunks(transferId: string, file: File): Promise<void> {
    const p2p = p2pRef.current;
    const key = sharedKeyRef.current;
    if (!p2p || p2p.connectionState !== 'connected' || !key) {
      console.error('[Remote] Cannot stream: not connected or no key');
      return;
    }
    const fileBuffer = await file.arrayBuffer();
    const fileHash = await sha256Hex(fileBuffer);
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    try {
      await p2p.sendRaw(JSON.stringify({ type: 'send_file_start', transferId, fileName: file.name, fileSize: file.size, totalChunks }));

      for (let i = 0; i < totalChunks; i++) {
        const start = i * CHUNK_SIZE;
        const plaintext = fileBuffer.slice(start, Math.min(start + CHUNK_SIZE, file.size));
        await p2p.sendRaw(await encryptChunk(key, plaintext));
        if ((i + 1) % 10 === 0 || i + 1 === totalChunks) {
          setTransfers((prev) => { const next = new Map(prev); const t = next.get(transferId); if (t) next.set(transferId, { ...t, chunksReceived: i + 1 }); return next; });
        }
      }

      await p2p.sendRaw(JSON.stringify({ type: 'send_file_end', transferId, sha256: fileHash }));
      setTransfers((prev) => { const next = new Map(prev); const t = next.get(transferId); if (t) next.set(transferId, { ...t, state: 'completed' }); return next; });
    } catch (e) {
      console.error('[Remote] Stream failed', e);
      setTransfers((prev) => { const next = new Map(prev); const t = next.get(transferId); if (t) next.set(transferId, { ...t, state: 'error' }); return next; });
    }
  }

  // ── Accept / reject ──────────────────────────────────────────────────────────

  const acceptRemoteTransfer = useCallback(async (transferId: string) => {
    setIncomingTransfer(null);
    try { await p2pRef.current?.sendRaw(JSON.stringify({ type: 'transfer_decision', transferId, accepted: true })); }
    catch (err) { console.error('[Remote] Accept failed', err); }
  }, []);

  const rejectRemoteTransfer = useCallback(async (transferId: string) => {
    setIncomingTransfer(null);
    try {
      await p2pRef.current?.sendRaw(JSON.stringify({ type: 'transfer_decision', transferId, accepted: false }));
      setTransfers((prev) => { const next = new Map(prev); const t = next.get(transferId); if (t) next.set(transferId, { ...t, state: 'rejected' }); return next; });
    } catch (err) { console.error('[Remote] Reject failed', err); }
  }, []);

  const dismissIncoming = useCallback(() => setIncomingTransfer(null), []);

  return { shareCode, remotePeer, transfers, incomingTransfer, createRoom, joinRoom, sendRemoteFile, acceptRemoteTransfer, rejectRemoteTransfer, dismissIncoming, disconnect };
}
