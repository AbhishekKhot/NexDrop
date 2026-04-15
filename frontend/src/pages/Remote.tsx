/**
 * Remote.tsx
 * Remote mode page — WebRTC-based peer-to-peer file transfer across networks.
 *
 * Architecture:
 *  This component owns the useRemoteTransfer() hook directly (unlike Lan.tsx,
 *  which receives its data from App.tsx via props).  Remote mode state is not
 *  shared with the rest of the app because WebRTC connections are scoped to this
 *  page — navigating away tears down the P2P connection via the cleanup in the
 *  mount/unmount effect.
 *
 * Room lifecycle:
 *  1. On mount: createRoom() — registers with the signaling server, gets a share code.
 *  2. User copies share code and sends it to their peer out-of-band (e.g. chat).
 *  3. Peer enters the code in their browser and clicks Connect → joinRoom().
 *  4. Signaling server relays SDP offer/answer + ICE candidates.
 *  5. WebRTC DataChannel opens → ECDH key exchange → file transfers can begin.
 *  6. On unmount (navigate away or close tab): disconnect() — closes P2P connection,
 *     cleans up IndexedDB receive buffers, cancels pending revoke timers.
 *
 * Why does this component call createRoom() on mount rather than on user action?
 * A share code is needed before the peer can connect.  Generating it immediately
 * on page load means the user always has a code ready to share without a button click.
 * The room has a TTL on the signaling server (default 10 min) — it expires if no
 * second peer joins, preventing orphaned rooms from accumulating on the server.
 *
 * Props (_props) are declared but unused:
 * The interface exists for future LAN-agent integration (peers, transfers from agent).
 * Currently Remote is fully self-contained via useRemoteTransfer, so the props are
 * prefixed _ and destructured as _props to suppress the TypeScript unused-variable warning.
 *
 * Fixes applied:
 *  ERR-05 — Remote transfer errors surfaced via toast
 *  QUAL-01 — Speed and ETA displayed for in-progress transfers
 */

import React, { useEffect, useRef } from 'react';
import type { Peer, Transfer } from '../types';
import DeviceCard from '../components/DeviceCard';
import ProgressBar from '../components/ProgressBar';
import IncomingTransferModal from '../components/IncomingTransferModal';
import { formatBytes, formatState, formatSpeed, formatETA } from '../lib/utils';
import { useRemoteTransfer } from '../hooks/useRemoteTransfer';
import { useToast } from '../lib/toast';

/**
 * RemoteProps — passed from App.tsx but currently unused by Remote.
 *
 * These props are reserved for a future design where the signaling-server
 * peer list is surfaced through the agent WebSocket (like LAN mode) instead
 * of being managed internally by useRemoteTransfer.  Keeping the interface
 * consistent with LanProps makes that refactor easier.
 */
interface RemoteProps {
    peers?: Peer[];
    transfers?: Map<string, Transfer>;
    agentConnected?: boolean;
    onSendFile?: (peerId: string, file: File) => void;
}

/**
 * SpeedSample — identical to the one in Lan.tsx.
 *
 * Duplicated rather than shared because the two pages may diverge in their
 * speed sampling strategies (e.g. WebRTC DataChannel chunk delivery patterns
 * differ from TCP-based LAN chunks).  A shared utility function would be the
 * right abstraction once both stabilise.
 *
 * See Lan.tsx SpeedSample for field documentation.
 */
interface SpeedSample {
    lastChunks: number;
    lastAt: number;
    bytesPerSec: number;
}

export default function Remote(_props: RemoteProps) {
    const { addToast } = useToast();
    const [selectedPeer, setSelectedPeer] = React.useState<Peer | null>(null);
    const [dragging, setDragging] = React.useState(false);
    const [inputShareCode, setInputShareCode] = React.useState('');
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    /** QUAL-01: per-transfer EMA speed samples — stored in ref to avoid extra renders */
    const speedSamples = useRef<Map<string, SpeedSample>>(new Map());

    const {
        shareCode: localShareCode,
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
        disconnect
    } = useRemoteTransfer();

    /**
     * ERR-05: Forward useRemoteTransfer lastError into the toast system.
     *
     * lastError is set by useRemoteTransfer on: ECDH key derivation failure,
     * chunk decryption failure (ERR-04), signaling WebSocket errors, DataChannel
     * errors, and SHA-256 integrity check failures.
     *
     * addToast is stable (useCallback [] deps) so it is safe as a useEffect dep.
     */
    useEffect(() => {
        if (lastError) {
            addToast(lastError, 'error');
        }
    }, [lastError, addToast]);

    /**
     * Room lifecycle management.
     *
     * createRoom() on mount: immediately acquire a share code so the user can
     * start sharing it before they have to take any other action.
     *
     * disconnect() on unmount: the return value of useEffect is the cleanup
     * function.  disconnect() closes the P2P connection, aborts any in-progress
     * transfer, cleans up IndexedDB chunk buffers (MEM-02), and cancels any
     * pending ObjectURL revoke timers (RACE-02).
     *
     * Why [createRoom, disconnect] in deps?
     * Both are useCallback with [] deps in useRemoteTransfer, so they are
     * referentially stable — the effect fires once on mount and not on re-renders.
     */
    useEffect(() => {
        createRoom();
        return () => disconnect();
    }, [createRoom, disconnect]);

    /**
     * handleFileDrop — drag-and-drop entry point for Remote mode.
     *
     * Gated on remotePeer !== null: if the DataChannel is not open, sendRemoteFile
     * would throw immediately.  The drop zone UI is only shown when selectedPeer
     * is set (which requires remotePeer to be set), so this guard is a safety net.
     */
    function handleFileDrop(e: React.DragEvent) {
        e.preventDefault();
        setDragging(false);
        if (!remotePeer) return;
        const file = e.dataTransfer.files[0];
        if (file) sendRemoteFile(file);
    }

    /**
     * handleFileInput — file picker entry point.
     *
     * e.target.value = '' resets the input so the same file can be selected again.
     * See Lan.tsx handleFileInput for the same pattern.
     */
    function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
        if (!remotePeer) return;
        const file = e.target.files?.[0];
        if (file) sendRemoteFile(file);
        e.target.value = '';
    }

    /**
     * getSpeedETA — exponential moving average speed and ETA for WebRTC transfers.
     *
     * Identical algorithm to Lan.tsx getSpeedETA.  See that function for a full
     * explanation of the EMA formula, sampling interval choice, and why chunkBytes
     * uses fileSize/totalChunks instead of the constant CHUNK_SIZE.
     *
     * Edge case: chunksReceived can stay at 0 for several seconds at the start
     * of a receive while the ECDH handshake completes and the first DataChannel
     * message arrives.  The bytesPerSec === 0 guard prevents displaying "0 B/s"
     * during that initialization period.
     */
    function getSpeedETA(t: Transfer): { speed: string; eta: string } | null {
        if (t.state !== 'transferring' || t.totalChunks === 0) return null;
        const chunkBytes = t.fileSize / t.totalChunks;
        const now = Date.now();
        let sample = speedSamples.current.get(t.id);
        if (!sample) {
            sample = { lastChunks: t.chunksReceived, lastAt: now, bytesPerSec: 0 };
            speedSamples.current.set(t.id, sample);
        } else {
            const elapsed = (now - sample.lastAt) / 1000;
            if (elapsed >= 1) {
                const deltaBps = ((t.chunksReceived - sample.lastChunks) * chunkBytes) / elapsed;
                // EMA: α = 0.3 for new data, 0.7 weight on history
                sample.bytesPerSec = sample.bytesPerSec === 0 ? deltaBps : sample.bytesPerSec * 0.7 + deltaBps * 0.3;
                sample.lastChunks = t.chunksReceived;
                sample.lastAt = now;
            }
        }
        if (sample.bytesPerSec === 0) return null;
        const remaining = (t.totalChunks - t.chunksReceived) * chunkBytes;
        return { speed: formatSpeed(sample.bytesPerSec), eta: formatETA(remaining, sample.bytesPerSec) };
    }

    /**
     * remotePeers — wraps the single remotePeer (or null) in an array so the
     * peer list UI can use .map() uniformly.  Remote mode supports only one
     * concurrent P2P connection per page session.
     */
    const remotePeers = remotePeer ? [remotePeer] : [];
    const remoteTransfers = Array.from(transfers.values());

    return (
        <div>
            <div className="page-header">
                <h1>🌐 Remote Transfer</h1>
                <p>
                    Send files to peers on any network using WebRTC DataChannels.
                    A tiny signaling server only relays the connection handshake — your file bytes are always P2P.
                </p>
            </div>

            {/*
             * Share code section — two-sided flow:
             *
             * Sender flow (this user has the code):
             *  localShareCode is displayed below the input field.  The other peer
             *  types this code into their input field and clicks Connect.
             *
             * Receiver flow (other user has the code):
             *  This user types the code into inputShareCode and clicks Connect,
             *  which calls joinRoom(code) → signaling server sends SDP offer back
             *  to the room creator → WebRTC negotiation begins.
             *
             * inputShareCode.trim(): the .trim() strips accidental whitespace from
             * copy-paste, which would cause a "room not found" error from the server.
             *
             * The Connect button is disabled when the input is empty to prevent
             * sending an empty join message to the signaling server.
             *
             * 'Generating...' placeholder: createRoom() is async — the localShareCode
             * may not be populated on the very first render.  The placeholder tells
             * the user to wait rather than showing a blank.
             */}
            <div className="section">
                <div className="section-header">
                    <span className="section-title">Connect to Remote Peer</span>
                </div>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <input
                        id="remote-share-code"
                        type="text"
                        placeholder="Enter peer's share code…"
                        value={inputShareCode}
                        onChange={(e) => setInputShareCode(e.target.value)}
                        style={{
                            flex: 1,
                            padding: '10px 14px',
                            background: 'var(--bg-elevated)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-sm)',
                            color: 'var(--text-primary)',
                            fontFamily: 'inherit',
                            fontSize: '0.9rem',
                            outline: 'none',
                        }}
                    />
                    <button
                        id="remote-connect-btn"
                        className="btn btn-primary"
                        disabled={!inputShareCode.trim()}
                        onClick={() => { joinRoom(inputShareCode.trim()); }}
                    >
                        Connect
                    </button>
                </div>
                <p style={{ marginTop: '8px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Share your code with the other person:{' '}
                    <strong style={{ color: 'var(--accent)', letterSpacing: '1px' }}>
                        {localShareCode || 'Generating...'}
                    </strong>
                </p>
            </div>

            {/*
             * Remote peers list — shown only when a DataChannel connection is established.
             *
             * remotePeers is either [] (no peer connected) or [remotePeer] (one peer).
             * Remote mode does not support more than one simultaneous P2P peer because
             * the signaling server room model is 2-party — a room is destroyed as soon
             * as both peers join.
             *
             * DeviceCard onClick: toggle selection — clicking the already-selected peer
             * deselects it (hides the drop zone).  The prev?.id === peer.id check in the
             * setSelectedPeer updater handles this toggle without an additional flag.
             */}
            {remotePeers.length > 0 && (
                <div className="section">
                    <div className="section-header">
                        <span className="section-title">
                            Remote Peers
                            <span style={{ background: 'var(--bg-elevated)', borderRadius: '99px', padding: '1px 8px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                                {remotePeers.length}
                            </span>
                        </span>
                    </div>
                    <div className="device-grid">
                        {remotePeers.map((peer) => (
                            <DeviceCard
                                key={peer.id}
                                peer={peer}
                                selected={selectedPeer?.id === peer.id}
                                onClick={() => setSelectedPeer((prev) => (prev?.id === peer.id ? null : peer))}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* Empty state: guides the user through the two-sided share code flow */}
            {remotePeers.length === 0 && (
                <div className="section">
                    <div className="empty-state">
                        <div className="empty-icon">🌍</div>
                        <p>No remote peers connected yet.</p>
                        <p style={{ marginTop: '4px' }}>Share your code or enter a peer's code above.</p>
                    </div>
                </div>
            )}

            {/*
             * File drop zone — shown only when a peer is selected.
             *
             * The drop zone is gated on selectedPeer (not just remotePeer) because
             * the user should explicitly choose the peer they want to send to, even
             * though currently only one remote peer is possible.  This mirrors the
             * LAN mode UX and keeps the two pages consistent.
             *
             * onDragOver must call e.preventDefault() to signal to the browser that
             * the element accepts drops — without it, the onDrop event never fires.
             *
             * The hidden file input is triggered programmatically via fileInputRef.current.click()
             * to keep full control over the drop zone styling without relying on the
             * browser's native file input button appearance.
             */}
            {selectedPeer && (
                <div className="section">
                    <div className="section-header">
                        <span className="section-title">
                            Send to <strong style={{ color: 'var(--accent)' }}>{selectedPeer.name}</strong>
                        </span>
                        <button className="btn btn-outline btn-sm" onClick={() => setSelectedPeer(null)}>
                            ✕ Deselect
                        </button>
                    </div>

                    <div
                        id="remote-drop-zone"
                        className={`drop-zone ${dragging ? 'drag-over' : ''}`}
                        onClick={() => fileInputRef.current?.click()}
                        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={handleFileDrop}
                    >
                        <span className="drop-icon">📁</span>
                        <p>Drag &amp; drop a file here, or <strong>click to browse</strong></p>
                    </div>
                    <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleFileInput} />
                </div>
            )}

            {/*
             * Transfer list — shows all remote transfers (send and receive).
             *
             * Tag label logic for Remote mode includes 'rejected' state (the peer
             * declined the transfer offer).  This state does not exist in LAN transfers
             * (the agent auto-rejects after 60s, but the UI shows 'error' in that path).
             *
             * Completed label distinguishes "Sent" (sender) from "Downloaded" (receiver)
             * because both directions are visible in the same list — the distinction
             * helps the user confirm who received what.
             *
             * pct = 0 when totalChunks === 0 (i.e. before the send_file_start message
             * is processed) — this prevents NaN from Math.round(0/0*100).
             */}
            {remoteTransfers.length > 0 && (
                <div className="section">
                    <div className="section-header">
                        <span className="section-title">Transfers</span>
                    </div>
                    <div className="transfer-list">
                        {remoteTransfers.map((t) => {
                            const pct = t.totalChunks > 0 ? Math.round((t.chunksReceived / t.totalChunks) * 100) : 0;
                            const speedETA = getSpeedETA(t);
                            return (
                                <div className="transfer-item" key={t.id}>
                                    <span className="transfer-icon">{t.direction === 'send' ? '⬆️' : '⬇️'}</span>
                                    <div className="transfer-info">
                                        <div className="transfer-name">{t.fileName}</div>
                                        <div className="transfer-meta">
                                            {formatBytes(t.fileSize)} · {t.peerName} · {formatState(t.state)}
                                            {/* QUAL-01: speed and ETA, visible only while transferring */}
                                            {speedETA && (
                                                <span style={{ marginLeft: '0.5rem', color: 'var(--text-muted)' }}>
                                                    · {speedETA.speed} · {speedETA.eta} left
                                                </span>
                                            )}
                                        </div>
                                        {/* Error detail: shown below the meta line so it doesn't crowd the primary info */}
                                        {t.state === 'error' && t.errorMessage && (
                                            <div style={{ fontSize: '0.75rem', color: '#e74c3c', marginTop: '2px' }}>
                                                {t.errorMessage}
                                            </div>
                                        )}
                                        {t.state === 'transferring' && (
                                            <div className="progress-bar-wrapper">
                                                <ProgressBar percent={pct} />
                                            </div>
                                        )}
                                    </div>
                                    {/*
                                     * Status tag: colour-coded by terminal state.
                                     * 'rejected' maps to the error colour (red) because it is a
                                     * failure path from the sender's perspective — the file was
                                     * not delivered.
                                     */}
                                    <span className={`tag tag-${t.state === 'completed' ? 'success' : (t.state === 'error' || t.state === 'rejected') ? 'error' : t.state === 'transferring' ? 'progress' : 'pending'}`}>
                                        {t.state === 'transferring' ? `${pct}%`
                                            : t.state === 'completed' ? (t.direction === 'send' ? 'Sent' : 'Downloaded')
                                            : t.state === 'rejected' ? 'Rejected'
                                            : formatState(t.state)}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/*
             * IncomingTransferModal for Remote mode.
             *
             * Rendered at the bottom of the Remote page (not at app root like in LAN mode)
             * because Remote transfers are scoped to this page — navigating to LAN would
             * tear down the P2P connection anyway via the disconnect() cleanup.
             *
             * incomingTransfer is set by useRemoteTransfer when the peer sends a
             * 'transfer_offer' message over the DataChannel.  Closing the modal via
             * onDismiss() does not reject the transfer (the peer's 60s timeout handles
             * cleanup), matching the same dismissal semantics as LAN mode.
             */}
            {incomingTransfer && (
                <IncomingTransferModal
                    transfer={incomingTransfer}
                    onAccept={() => acceptRemoteTransfer(incomingTransfer.id)}
                    onReject={() => rejectRemoteTransfer(incomingTransfer.id)}
                    onDismiss={() => dismissIncoming()}
                />
            )}
        </div>
    );
}
