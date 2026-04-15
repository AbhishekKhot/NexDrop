/**
 * Lan.tsx
 * LAN mode page — peer discovery, file sending, and transfer progress for
 * devices on the same local network.
 *
 * Data flow:
 *  App.tsx → useAgentSocket() → props here
 *
 * This component is purely presentational relative to the agent connection:
 * it receives peers and transfers as props and calls onSendFile / onDiscover
 * callbacks.  It owns only local UI state (selectedPeer, dragging).
 *
 * Key design choices:
 *  - SpeedSample is stored in a ref (not state) so updating it during render
 *    does not trigger additional render cycles — the speed display updates
 *    naturally on the next render triggered by a new transfer_update message.
 *  - sendFile() wraps onSendFile in a try/catch to convert synchronous errors
 *    (e.g. "File too large" thrown before the async stream starts) into toasts.
 *    Async errors are caught in useAgentSocket.sendFile → setLastError → App.tsx
 *    useEffect → addToast.
 *
 * Fixes applied:
 *  ERR-05 — Send errors surfaced via toast
 *  QUAL-01 — Speed and ETA displayed for in-progress transfers
 */

import React, { useRef, useEffect } from 'react';
import type { Peer, Transfer } from '../types';
import DeviceCard from '../components/DeviceCard';
import ProgressBar from '../components/ProgressBar';
import { formatBytes, formatState, formatSpeed, formatETA } from '../lib/utils';
import { useToast } from '../lib/toast';

interface LanProps {
    peers: Peer[];
    transfers: Map<string, Transfer>;
    agentConnected: boolean;
    agentFailed?: boolean;
    onSendFile: (peerId: string, file: File) => void;
    onDiscover: () => void;
}

/**
 * SpeedSample — per-transfer speed tracking structure stored in a ref Map.
 *
 * Why a ref and not state?
 * Speed samples are derived UI data — not source data that should cause a
 * component to re-render on their own.  Storing them in state would trigger
 * an extra render every time the EMA is updated (every second during a transfer),
 * doubling render frequency.  A ref update is invisible to React's diffing,
 * so the speed display is refreshed only when the parent already re-renders due
 * to a new transfer_update message.
 *
 * Fields:
 *  lastChunks  — chunksReceived at the time of the last sample (for delta calc)
 *  lastAt      — timestamp of last sample (ms since epoch)
 *  bytesPerSec — exponential moving average speed (0 until first full second elapses)
 */
interface SpeedSample {
    lastChunks: number;
    lastAt: number;
    bytesPerSec: number;
}

export default function Lan({ peers, transfers, agentConnected, agentFailed, onSendFile, onDiscover }: LanProps) {
    const { addToast } = useToast();
    const [selectedPeer, setSelectedPeer] = React.useState<Peer | null>(null);
    const [dragging, setDragging] = React.useState(false);
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    /**
     * QUAL-01: speed samples ref — keyed by transfer ID.
     *
     * A single Map is used (not individual refs per transfer) so new transfers
     * can be added and old ones removed without changing the ref object itself.
     * React's ref guarantee means the Map reference is stable across renders.
     */
    const speedSamples = useRef<Map<string, SpeedSample>>(new Map());

    /**
     * Cleanup: remove speed samples for transfers that are no longer 'transferring'.
     *
     * Why no deps array (runs on every render)?
     * This effect fires after every render, which is intentional — the transfers
     * prop changes on every transfer_update message, so there is no benefit to
     * gating on a specific dep.  The per-key lookup is O(n) on the sample count,
     * which is bounded by the number of concurrent transfers (typically 1-2).
     */
    useEffect(() => {
        for (const id of speedSamples.current.keys()) {
            const t = transfers.get(id);
            if (!t || t.state !== 'transferring') {
                speedSamples.current.delete(id);
            }
        }
    });

    /**
     * handleFileDrop — drag-and-drop entry point.
     *
     * e.preventDefault() suppresses the browser's default behaviour of navigating
     * to the dropped file (for text/URI-list drops) or opening it inline (for images).
     *
     * Only the first file is taken (files[0]); multi-file drag is not supported —
     * the agent's serial queue would handle it, but the UX for tracking multiple
     * concurrent drops is not implemented.
     */
    function handleFileDrop(e: React.DragEvent) {
        e.preventDefault();
        setDragging(false);
        if (!selectedPeer) return;
        const file = e.dataTransfer.files[0];
        if (file) sendFile(selectedPeer.id, file);
    }

    /**
     * handleFileInput — file picker (click-to-browse) entry point.
     *
     * e.target.value = '' resets the input element after the file is taken.
     * Without this reset, selecting the same file twice in a row would not fire
     * a second onChange event (the browser considers the value unchanged).
     */
    function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
        if (!selectedPeer) return;
        const file = e.target.files?.[0];
        if (file) sendFile(selectedPeer.id, file);
        e.target.value = '';
    }

    /**
     * sendFile — thin wrapper that catches synchronous errors from onSendFile.
     *
     * onSendFile (useAgentSocket.sendFile) is async internally, but it can throw
     * synchronously for cases like "agent not connected" before the Promise is
     * created.  The try/catch here converts those into toasts (ERR-05).
     *
     * Async errors (from inside the Promise) propagate via setLastError in
     * useAgentSocket → the useEffect in App.tsx → addToast there.
     */
    function sendFile(peerId: string, file: File) {
        try {
            onSendFile(peerId, file);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            addToast(msg, 'error');
        }
    }

    /**
     * lanTransfers — filter the shared transfers Map to only include transfers
     * whose peerId matches one of the LAN peers passed to this component.
     *
     * App.tsx already filters peers to mode === 'lan', so this filter is a
     * secondary guard that prevents remote-mode transfers from appearing in the
     * LAN transfer list if the data is ever inconsistent.
     */
    const lanTransfers = Array.from(transfers.values()).filter((t) =>
        peers.some((p) => p.id === t.peerId)
    );

    /**
     * getSpeedETA — compute human-readable speed and ETA for an active transfer.
     *
     * Returns null when:
     *  - Transfer is not in 'transferring' state
     *  - totalChunks is 0 (metadata not yet received)
     *  - No full second has elapsed since the first sample (bytesPerSec still 0)
     *
     * Speed algorithm: Exponential Moving Average (EMA) with α = 0.3.
     *  newSpeed = oldSpeed * 0.7 + instantaneousSpeed * 0.3
     *
     * Why EMA instead of a rolling window?
     * EMA requires storing only one value (no array of past samples) and provides
     * natural smoothing that dampens momentary spikes (e.g. from TCP burst-then-drain
     * behavior) while still tracking trend changes within a few seconds.
     *
     * Why sample at 1-second intervals?
     * Sub-second intervals produce noisy readings because chunk delivery from the
     * agent to the UI is batched over WebSocket frames. 1 second gives a stable
     * numerator (deltaBytesPerSec) while keeping the display responsive.
     *
     * chunkBytes = fileSize / totalChunks rather than the constant CHUNK_SIZE because
     * the final chunk may be smaller — using the average is accurate enough for ETA.
     */
    function getSpeedETA(t: Transfer): { speed: string; eta: string } | null {
        if (t.state !== 'transferring' || t.totalChunks === 0) return null;

        const chunkBytes = t.fileSize / t.totalChunks;
        const now = Date.now();
        let sample = speedSamples.current.get(t.id);

        if (!sample) {
            // First time we see this transfer — initialise the sample; no speed yet
            sample = { lastChunks: t.chunksReceived, lastAt: now, bytesPerSec: 0 };
            speedSamples.current.set(t.id, sample);
        } else {
            const elapsed = (now - sample.lastAt) / 1000;
            if (elapsed >= 1) {
                // At least one full second has passed — compute delta and apply EMA
                const deltaBytesPerSec = ((t.chunksReceived - sample.lastChunks) * chunkBytes) / elapsed;
                sample.bytesPerSec = sample.bytesPerSec === 0
                    ? deltaBytesPerSec                                    // first real sample — use directly
                    : sample.bytesPerSec * 0.7 + deltaBytesPerSec * 0.3; // EMA smoothing
                sample.lastChunks = t.chunksReceived;
                sample.lastAt = now;
            }
        }

        if (sample.bytesPerSec === 0) return null; // not enough data yet
        const remaining = (t.totalChunks - t.chunksReceived) * chunkBytes;
        return { speed: formatSpeed(sample.bytesPerSec), eta: formatETA(remaining, sample.bytesPerSec) };
    }

    return (
        <div>
            <div className="page-header">
                <h1>📡 LAN Transfer</h1>
                <p>
                    {agentFailed
                        ? 'Agent unreachable — restart the backend and reload.'
                        : agentConnected
                        ? 'Local agent connected — showing devices on your network.'
                        : 'Local agent is offline. Run `cd backend && npm run dev` to discover LAN peers.'}
                </p>
            </div>

            {/* Peer discovery */}
            <div className="section">
                <div className="section-header">
                    <span className="section-title">
                        <span>Devices on Network</span>
                        <span style={{ background: 'var(--bg-elevated)', borderRadius: '99px', padding: '1px 8px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                            {peers.length}
                        </span>
                    </span>
                    <button className="btn btn-outline btn-sm" onClick={onDiscover} disabled={!agentConnected}>
                        <span>🔍</span> Scan
                    </button>
                </div>

                {peers.length === 0 ? (
                    <div className="empty-state">
                        <div className="empty-icon">📭</div>
                        <p>No devices found on LAN yet.</p>
                        <p style={{ marginTop: '4px' }}>Make sure the agent is running and click Scan.</p>
                    </div>
                ) : (
                    <div className="device-grid">
                        {peers.map((peer) => (
                            <DeviceCard
                                key={peer.id}
                                peer={peer}
                                selected={selectedPeer?.id === peer.id}
                                onClick={() => setSelectedPeer((prev) => (prev?.id === peer.id ? null : peer))}
                            />
                        ))}
                    </div>
                )}
            </div>

            {/* File drop zone */}
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
                        id="lan-drop-zone"
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

            {/* Transfer history */}
            {lanTransfers.length > 0 && (
                <div className="section">
                    <div className="section-header">
                        <span className="section-title">Transfers</span>
                    </div>
                    <div className="transfer-list">
                        {lanTransfers.map((t) => {
                            const pct = t.totalChunks > 0 ? Math.round((t.chunksReceived / t.totalChunks) * 100) : 0;
                            const speedETA = getSpeedETA(t);
                            return (
                                <div className="transfer-item" key={t.id}>
                                    <span className="transfer-icon">{t.direction === 'send' ? '⬆️' : '⬇️'}</span>
                                    <div className="transfer-info">
                                        <div className="transfer-name">{t.fileName}</div>
                                        <div className="transfer-meta">
                                            {formatBytes(t.fileSize)} · {t.peerName} · {formatState(t.state)}
                                            {/* QUAL-01: speed and ETA */}
                                            {speedETA && (
                                                <span style={{ marginLeft: '0.5rem', color: 'var(--text-muted)' }}>
                                                    · {speedETA.speed} · {speedETA.eta} left
                                                </span>
                                            )}
                                        </div>
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
                                    <span className={`tag tag-${t.state === 'completed' ? 'success' : t.state === 'error' ? 'error' : t.state === 'transferring' ? 'progress' : 'pending'}`}>
                                        {t.state === 'transferring' ? `${pct}%` : t.state}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
