import { useCallback, useEffect, useRef, useState } from 'react';
import {
  generateECDHKeyPair,
  exportPublicKeyBase64,
  importPublicKeyBase64,
  deriveSharedKey,
  encryptChunk,
  decryptChunk,
  type ECDHKeyPair,
} from '../lib/remoteCrypto';
import type { Peer, Transfer } from '../types';

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

const RELAY_URL =
  (import.meta as unknown as { env: Record<string, string> }).env
    .VITE_RELAY_URL ?? 'ws://localhost:4002';

const PROTOCOL_VERSION = 1;

// Must match backend RELAY_CHUNK_SIZE (1 MiB).
const CHUNK_SIZE = 1024 * 1024;

// Receivers without the File System Access API accumulate a Blob in memory;
// cap that path well under the point where browsers refuse to allocate.
const BLOB_MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

// Pause the sender's reader when the socket's send buffer exceeds HIGH; resume
// below LOW. Mirrors the relay's own watermarks.
const BACKPRESSURE_HIGH = 8 * 1024 * 1024;
const BACKPRESSURE_LOW = 1 * 1024 * 1024;

const REMOTE_PEER: Peer = {
  id: 'remote-peer',
  name: 'Remote Peer',
  mode: 'remote',
  status: 'available',
};

// ── File System Access API (typed minimally; not in all lib.dom versions) ──
interface WritableFileStreamLike {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
interface FileHandleLike {
  createWritable(): Promise<WritableFileStreamLike>;
}
type ShowSaveFilePicker = (opts?: {
  suggestedName?: string;
}) => Promise<FileHandleLike>;

function getSaveFilePicker(): ShowSaveFilePicker | null {
  const w = window as unknown as { showSaveFilePicker?: ShowSaveFilePicker };
  return typeof w.showSaveFilePicker === 'function' ? w.showSaveFilePicker : null;
}

// Strip control chars and path separators so a peer-supplied name is safe to
// show and to pass as a save-dialog suggestion (the peer is untrusted).
function safeFileName(name: unknown): string {
  if (typeof name !== 'string') return 'download';
  let out = '';
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 32 && c !== 127 && ch !== '/' && ch !== '\\') out += ch;
  }
  return out.slice(0, 255) || 'download';
}

interface ReceiveState {
  transferId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  received: number;
  expectedIndex: number;
  writer: WritableFileStreamLike | null; // FSA path
  parts: ArrayBuffer[] | null; // Blob fallback path
}

export function useRemoteTransfer(): RemoteTransferState {
  const [shareCode, setShareCode] = useState<string | null>(null);
  const [remotePeer, setRemotePeer] = useState<Peer | null>(null);
  const [transfers, setTransfers] = useState<Map<string, Transfer>>(new Map());
  const [incomingTransfer, setIncomingTransfer] = useState<Transfer | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  // Serializes incoming-message processing in strict arrival order. Both
  // handlers are async (key gate, decrypt, disk write); without this a trailing
  // transfer_end could finalize before an in-flight chunk is counted.
  const processingChainRef = useRef<Promise<void>>(Promise.resolve());
  // 'create' | { join: code } — applied once the welcome handshake completes.
  const pendingIntentRef = useRef<'create' | { join: string } | null>(null);
  const relayMaxFileSizeRef = useRef<number>(BLOB_MAX_FILE_SIZE);
  const peerMaxFileSizeRef = useRef<number>(0);

  const keyPairRef = useRef<ECDHKeyPair | null>(null);
  const sharedKeyRef = useRef<CryptoKey | null>(null);
  const keyReadyRef = useRef<Promise<void>>(Promise.resolve());
  const keyReadyResolveRef = useRef<(() => void) | null>(null);
  const keyFailedRef = useRef(false);

  const receiveRef = useRef<ReceiveState | null>(null);
  const pendingSendRef = useRef<Map<string, File>>(new Map());
  const revokeTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── crypto helpers ──────────────────────────────────────────────────
  const resetCrypto = useCallback(() => {
    keyPairRef.current = null;
    sharedKeyRef.current = null;
    keyFailedRef.current = false;
    keyReadyRef.current = new Promise<void>((resolve) => {
      keyReadyResolveRef.current = resolve;
    });
  }, []);

  const startKeyExchange = useCallback(async () => {
    try {
      const pair = await generateECDHKeyPair();
      keyPairRef.current = pair;
      const pub = await exportPublicKeyBase64(pair.publicKey);
      wsRef.current?.send(JSON.stringify({ t: 'ecdh_hello', publicKey: pub }));
    } catch (err) {
      console.error('[Remote] key exchange init failed', err);
      keyFailedRef.current = true;
      keyReadyResolveRef.current?.();
    }
  }, []);

  const finishKeyExchange = useCallback(async (peerPubB64: string) => {
    try {
      if (!keyPairRef.current) {
        keyFailedRef.current = true;
        keyReadyResolveRef.current?.();
        return;
      }
      const peerPub = await importPublicKeyBase64(peerPubB64);
      sharedKeyRef.current = await deriveSharedKey(
        keyPairRef.current.privateKey,
        peerPub,
      );
      keyReadyResolveRef.current?.();
    } catch (err) {
      console.error('[Remote] shared key derivation failed', err);
      keyFailedRef.current = true;
      keyReadyResolveRef.current?.();
    }
  }, []);

  // ── transfer-state helpers ──────────────────────────────────────────
  const patchTransfer = useCallback(
    (id: string, patch: Partial<Transfer>) => {
      setTransfers((prev) => {
        const next = new Map(prev);
        const t = next.get(id);
        if (t) next.set(id, { ...t, ...patch });
        return next;
      });
    },
    [],
  );

  const failTransfer = useCallback(
    (id: string, message: string) => {
      patchTransfer(id, { state: 'error', errorMessage: message });
      setLastError(message);
    },
    [patchTransfer],
  );

  // ── receive finalisation ────────────────────────────────────────────
  const finalizeReceive = useCallback(async () => {
    const rm = receiveRef.current;
    if (!rm) return;
    receiveRef.current = null;

    if (rm.received !== rm.totalChunks) {
      if (rm.writer) await rm.writer.abort?.();
      failTransfer(rm.transferId, 'Incomplete transfer — missing chunks');
      return;
    }

    try {
      if (rm.writer) {
        await rm.writer.close();
      } else if (rm.parts) {
        const blob = new Blob(rm.parts);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = rm.fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        const timer = setTimeout(() => {
          URL.revokeObjectURL(url);
          revokeTimersRef.current.delete(rm.transferId);
        }, 1000);
        revokeTimersRef.current.set(rm.transferId, timer);
      }
      patchTransfer(rm.transferId, { state: 'completed', completedAt: Date.now() });
    } catch (err) {
      console.error('[Remote] finalize failed', err);
      failTransfer(rm.transferId, 'Failed to save received file');
    }
  }, [failTransfer, patchTransfer]);

  const abortReceive = useCallback(
    (message: string) => {
      const rm = receiveRef.current;
      if (!rm) return;
      receiveRef.current = null;
      void rm.writer?.abort?.();
      failTransfer(rm.transferId, message);
    },
    [failTransfer],
  );

  // ── incoming binary chunk ───────────────────────────────────────────
  const handleBinary = useCallback(
    async (data: ArrayBuffer) => {
      const rm = receiveRef.current;
      if (!rm) return;

      await keyReadyRef.current;
      if (keyFailedRef.current || !sharedKeyRef.current) {
        abortReceive('Key exchange failed — transfer aborted');
        return;
      }

      if (data.byteLength < 4) {
        abortReceive('Malformed chunk frame');
        return;
      }
      const index = new DataView(data).getUint32(0, false);
      if (index !== rm.expectedIndex) {
        abortReceive(`Chunk out of order (expected ${rm.expectedIndex}, got ${index})`);
        return;
      }

      let plaintext: ArrayBuffer;
      try {
        plaintext = await decryptChunk(sharedKeyRef.current, data.slice(4));
      } catch {
        abortReceive('Decryption failed — transfer may have been tampered with');
        return;
      }

      try {
        if (rm.writer) await rm.writer.write(plaintext);
        else rm.parts?.push(plaintext);
      } catch (err) {
        console.error('[Remote] write failed', err);
        abortReceive('Failed to write received chunk');
        return;
      }

      rm.expectedIndex++;
      rm.received++;
      if (rm.received % 8 === 0 || rm.received === rm.totalChunks) {
        patchTransfer(rm.transferId, { chunksReceived: rm.received });
      }
    },
    [abortReceive, patchTransfer],
  );

  // ── control-frame dispatch ──────────────────────────────────────────
  const handleControl = useCallback(
    async (msg: Record<string, unknown>) => {
      switch (msg.t) {
        case 'welcome': {
          if (typeof msg.maxFileSize === 'number') {
            relayMaxFileSizeRef.current = msg.maxFileSize;
          }
          // Our receive capability: stream-to-disk (FSA) can take the relay
          // cap; the Blob fallback is limited to BLOB_MAX_FILE_SIZE.
          const myCap = getSaveFilePicker()
            ? relayMaxFileSizeRef.current
            : Math.min(relayMaxFileSizeRef.current, BLOB_MAX_FILE_SIZE);
          const intent = pendingIntentRef.current;
          pendingIntentRef.current = null;
          if (intent === 'create') {
            wsRef.current?.send(JSON.stringify({ t: 'create', maxFileSize: myCap }));
          } else if (intent && 'join' in intent) {
            wsRef.current?.send(
              JSON.stringify({ t: 'join', code: intent.join, maxFileSize: myCap }),
            );
          }
          break;
        }
        case 'created':
          setShareCode(msg.code as string);
          break;
        case 'joined':
          setShareCode(msg.code as string);
          peerMaxFileSizeRef.current = (msg.peerMaxFileSize as number) ?? 0;
          setRemotePeer(REMOTE_PEER);
          resetCrypto();
          void startKeyExchange();
          break;
        case 'peer_joined':
          peerMaxFileSizeRef.current = (msg.peerMaxFileSize as number) ?? 0;
          setRemotePeer(REMOTE_PEER);
          resetCrypto();
          void startKeyExchange();
          break;
        case 'peer_left':
          setRemotePeer(null);
          sharedKeyRef.current = null;
          if (receiveRef.current) abortReceive('Peer disconnected');
          break;
        case 'ecdh_hello':
          await finishKeyExchange(msg.publicKey as string);
          break;
        case 'offer_transfer': {
          const transferId = msg.transferId as string;
          const offer: Transfer = {
            id: transferId,
            peerId: REMOTE_PEER.id,
            peerName: REMOTE_PEER.name,
            direction: 'receive',
            fileName: safeFileName(msg.fileName),
            fileSize: typeof msg.fileSize === 'number' ? msg.fileSize : 0,
            totalChunks: typeof msg.totalChunks === 'number' ? msg.totalChunks : 0,
            chunksReceived: 0,
            state: 'pending',
          };
          setIncomingTransfer(offer);
          setTransfers((prev) => new Map(prev).set(transferId, offer));
          break;
        }
        case 'transfer_decision': {
          const transferId = msg.transferId as string;
          const accepted = msg.accepted === true;
          if (accepted) {
            patchTransfer(transferId, { state: 'transferring' });
            const file = pendingSendRef.current.get(transferId);
            if (file) {
              pendingSendRef.current.delete(transferId);
              void streamFile(transferId, file);
            }
          } else {
            pendingSendRef.current.delete(transferId);
            patchTransfer(transferId, { state: 'rejected', errorMessage: 'Rejected by peer' });
          }
          break;
        }
        case 'transfer_begin': {
          // Receiver side: sender armed the transfer. receiveRef was prepared in
          // acceptRemoteTransfer (incl. the FSA writer opened under a user gesture).
          const rm = receiveRef.current;
          if (rm && rm.transferId === msg.transferId) {
            if (typeof msg.totalChunks === 'number') rm.totalChunks = msg.totalChunks;
            patchTransfer(rm.transferId, { state: 'transferring', totalChunks: rm.totalChunks });
          }
          break;
        }
        case 'transfer_end':
          void finalizeReceive();
          break;
        case 'error':
          setLastError(`Relay: ${String(msg.code ?? 'unknown error')}`);
          break;
      }
    },
    [abortReceive, finalizeReceive, finishKeyExchange, patchTransfer, resetCrypto, startKeyExchange],
  );

  // streamFile is defined as a stable ref-reading function (not a useCallback)
  // so handleControl can call it without a dependency cycle.
  const streamFileRef = useRef<(transferId: string, file: File) => Promise<void>>(
    async () => undefined,
  );
  streamFileRef.current = async (transferId: string, file: File) => {
    const ws = wsRef.current;
    const key = sharedKeyRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !key) {
      failTransfer(transferId, 'Not connected to a remote peer');
      return;
    }
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
    ws.send(JSON.stringify({ t: 'transfer_begin', transferId, fileSize: file.size, totalChunks }));

    try {
      for (let i = 0; i < totalChunks; i++) {
        const slice = file.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, file.size));
        const plaintext = await slice.arrayBuffer();
        const encrypted = await encryptChunk(key, plaintext);
        const frame = new Uint8Array(4 + encrypted.byteLength);
        new DataView(frame.buffer).setUint32(0, i, false);
        frame.set(new Uint8Array(encrypted), 4);

        if (ws.bufferedAmount > BACKPRESSURE_HIGH) await waitForDrain(ws);
        if (ws.readyState !== WebSocket.OPEN) throw new Error('connection lost');
        ws.send(frame);

        if ((i + 1) % 8 === 0 || i + 1 === totalChunks) {
          patchTransfer(transferId, { chunksReceived: i + 1 });
        }
      }
      ws.send(JSON.stringify({ t: 'transfer_end', transferId }));
      patchTransfer(transferId, { state: 'completed', completedAt: Date.now() });
    } catch (err) {
      console.error('[Remote] send failed', err);
      failTransfer(transferId, 'Transfer failed — the connection may have dropped');
    }
  };
  function streamFile(transferId: string, file: File): Promise<void> {
    return streamFileRef.current(transferId, file);
  }

  // ── connection ──────────────────────────────────────────────────────
  const connect = useCallback(
    (intent: 'create' | { join: string }) => {
      try {
        wsRef.current?.close();
      } catch {
        /* already closed */
      }
      pendingIntentRef.current = intent;
      processingChainRef.current = Promise.resolve();
      const ws = new WebSocket(RELAY_URL);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION }));
      ws.onmessage = (event) => {
        const { data } = event;
        // Chain so each message fully processes before the next — preserves
        // transfer_begin → chunks → transfer_end ordering across async handlers.
        processingChainRef.current = processingChainRef.current
          .then(() => {
            if (typeof data === 'string') {
              let msg: Record<string, unknown>;
              try {
                msg = JSON.parse(data);
              } catch {
                return undefined;
              }
              return handleControl(msg);
            }
            if (data instanceof ArrayBuffer) return handleBinary(data);
            return undefined;
          })
          .catch((err) => console.error('[Remote] message handler error', err));
      };
      ws.onerror = () => setLastError('Relay connection error');
      ws.onclose = () => {
        if (wsRef.current === ws) setRemotePeer(null);
      };
    },
    [handleBinary, handleControl],
  );

  const createRoom = useCallback(() => {
    setShareCode(null);
    connect('create');
  }, [connect]);

  const joinRoom = useCallback(
    (code: string) => {
      const trimmed = code.trim().toUpperCase();
      if (!/^[0-9A-HJKMNP-TV-Z]{10}$/.test(trimmed)) {
        setLastError('Invalid share code');
        return;
      }
      setShareCode(null);
      connect({ join: trimmed });
    },
    [connect],
  );

  // ── send ────────────────────────────────────────────────────────────
  const sendRemoteFile = useCallback(
    async (file: File) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !remotePeer) {
        setLastError('Not connected to a remote peer');
        return;
      }
      const cap = Math.min(
        relayMaxFileSizeRef.current,
        peerMaxFileSizeRef.current || relayMaxFileSizeRef.current,
      );
      if (file.size > cap) {
        setLastError(
          `File is too large for this transfer (max ${Math.floor(cap / (1024 * 1024))} MB). ` +
            `The receiver may need Chrome/Edge for larger files.`,
        );
        return;
      }

      await keyReadyRef.current;
      if (keyFailedRef.current || !sharedKeyRef.current) {
        setLastError('Secure channel not ready — try reconnecting');
        return;
      }

      const transferId = crypto.randomUUID();
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE) || 1;
      setTransfers((prev) =>
        new Map(prev).set(transferId, {
          id: transferId,
          peerId: REMOTE_PEER.id,
          peerName: REMOTE_PEER.name,
          direction: 'send',
          fileName: file.name,
          fileSize: file.size,
          totalChunks,
          chunksReceived: 0,
          state: 'pending',
        }),
      );
      pendingSendRef.current.set(transferId, file);
      ws.send(
        JSON.stringify({
          t: 'offer_transfer',
          transferId,
          fileName: file.name,
          fileSize: file.size,
          totalChunks,
        }),
      );
    },
    [remotePeer],
  );

  // ── accept / reject ─────────────────────────────────────────────────
  const acceptRemoteTransfer = useCallback(
    async (transferId: string) => {
      const offer = transfers.get(transferId);
      setIncomingTransfer(null);
      if (!offer) return;

      // Open the FSA writer here — acceptRemoteTransfer runs inside the modal's
      // click handler, the user gesture showSaveFilePicker() requires.
      const picker = getSaveFilePicker();
      let writer: WritableFileStreamLike | null = null;
      if (picker) {
        try {
          const handle = await picker({ suggestedName: offer.fileName });
          writer = await handle.createWritable();
        } catch {
          // User cancelled the save dialog → treat as reject.
          wsRef.current?.send(
            JSON.stringify({ t: 'transfer_decision', transferId, accepted: false }),
          );
          patchTransfer(transferId, { state: 'rejected', errorMessage: 'Save cancelled' });
          return;
        }
      }

      receiveRef.current = {
        transferId,
        fileName: offer.fileName,
        fileSize: offer.fileSize,
        totalChunks: offer.totalChunks,
        received: 0,
        expectedIndex: 0,
        writer,
        parts: writer ? null : [],
      };
      patchTransfer(transferId, { state: 'transferring' });
      wsRef.current?.send(
        JSON.stringify({ t: 'transfer_decision', transferId, accepted: true }),
      );
    },
    [patchTransfer, transfers],
  );

  const rejectRemoteTransfer = useCallback(
    (transferId: string) => {
      setIncomingTransfer(null);
      wsRef.current?.send(
        JSON.stringify({ t: 'transfer_decision', transferId, accepted: false }),
      );
      patchTransfer(transferId, { state: 'rejected' });
    },
    [patchTransfer],
  );

  const dismissIncoming = useCallback(() => setIncomingTransfer(null), []);

  // ── teardown ────────────────────────────────────────────────────────
  const disconnect = useCallback(() => {
    for (const timer of revokeTimersRef.current.values()) clearTimeout(timer);
    revokeTimersRef.current.clear();
    void receiveRef.current?.writer?.abort?.();
    receiveRef.current = null;
    pendingSendRef.current.clear();
    try {
      wsRef.current?.close();
    } catch {
      /* already closed */
    }
    wsRef.current = null;
    sharedKeyRef.current = null;
    keyPairRef.current = null;
    setShareCode(null);
    setRemotePeer(null);
    setIncomingTransfer(null);
  }, []);

  useEffect(() => () => disconnect(), [disconnect]);

  return {
    shareCode,
    remotePeer,
    incomingTransfer,
    transfers,
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

function waitForDrain(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount <= BACKPRESSURE_LOW) {
        resolve();
      } else {
        setTimeout(check, 20);
      }
    };
    setTimeout(check, 20);
  });
}
