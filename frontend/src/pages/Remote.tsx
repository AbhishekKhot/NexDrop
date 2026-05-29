import React, { useEffect, useRef } from 'react';
import type { Transfer } from '../types';
import DeviceCard from '../components/DeviceCard';
import ProgressBar from '../components/ProgressBar';
import IncomingTransferModal from '../components/IncomingTransferModal';
import { formatBytes, formatState, formatSpeed, formatETA } from '../lib/utils';
import { useRemoteTransfer } from '../hooks/useRemoteTransfer';
import { useToast } from '../lib/toast';
import { setRemoteStatus } from '../lib/remoteStatus';

interface SpeedSample {
    lastChunks: number;
    lastAt: number;
    bytesPerSec: number;
}

export default function Remote() {
    const { addToast } = useToast();
    const [selectedPeer, setSelectedPeer] = React.useState(false);
    const [dragging, setDragging] = React.useState(false);
    const [inputShareCode, setInputShareCode] = React.useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const speedSamples = useRef<Map<string, SpeedSample>>(new Map());

    const {
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
    } = useRemoteTransfer();

    useEffect(() => {
        if (lastError) addToast(lastError, 'error');
    }, [lastError, addToast]);

    // Auto-create a room on mount so the user has a share code ready; tear the
    // relay connection (and any in-flight receive) down on unmount.
    useEffect(() => {
        createRoom();
        return () => disconnect();
    }, [createRoom, disconnect]);

    // When the peer connects, surface the send panel; clear it when they leave.
    useEffect(() => {
        setSelectedPeer(remotePeer !== null);
    }, [remotePeer]);

    // Report relay/peer connection to the app header (status indicator).
    useEffect(() => {
        setRemoteStatus({ relayConnected: shareCode !== null, peerConnected: remotePeer !== null });
    }, [shareCode, remotePeer]);
    useEffect(() => () => setRemoteStatus({ relayConnected: false, peerConnected: false }), []);

    function handleFileDrop(e: React.DragEvent) {
        e.preventDefault();
        setDragging(false);
        if (!remotePeer) return;
        const file = e.dataTransfer.files[0];
        if (file) void sendRemoteFile(file);
    }

    function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
        if (!remotePeer) return;
        const file = e.target.files?.[0];
        if (file) void sendRemoteFile(file);
        e.target.value = '';
    }

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
                sample.bytesPerSec = sample.bytesPerSec === 0 ? deltaBps : sample.bytesPerSec * 0.7 + deltaBps * 0.3;
                sample.lastChunks = t.chunksReceived;
                sample.lastAt = now;
            }
        }
        if (sample.bytesPerSec === 0) return null;
        const remaining = (t.totalChunks - t.chunksReceived) * chunkBytes;
        return { speed: formatSpeed(sample.bytesPerSec), eta: formatETA(remaining, sample.bytesPerSec) };
    }

    const remotePeers = remotePeer ? [remotePeer] : [];
    const remoteTransfers = Array.from(transfers.values());

    return (
        <div>
            <div className="page-header">
                <h1>NexDrop — Instant File Sharing</h1>
                <p>
                    Send a file to anyone, anywhere. No accounts, no installs, no uploads
                    to a server. File contents are end-to-end encrypted (ECDH + AES-256-GCM)
                    — the relay forwards ciphertext only and never sees your bytes.
                </p>
            </div>

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
                            letterSpacing: '1px',
                            textTransform: 'uppercase',
                        }}
                    />
                    <button
                        id="remote-connect-btn"
                        className="btn btn-primary"
                        disabled={!inputShareCode.trim()}
                        onClick={() => joinRoom(inputShareCode.trim())}
                    >
                        Connect
                    </button>
                </div>
                <p style={{ marginTop: '8px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Share your code with the other person:{' '}
                    <strong style={{ color: 'var(--accent)', letterSpacing: '1px' }}>
                        {shareCode || 'Generating…'}
                    </strong>
                </p>
            </div>

            {remotePeers.length > 0 ? (
                <div className="section">
                    <div className="section-header">
                        <span className="section-title">
                            Remote Peer
                            <span style={{ background: 'var(--bg-elevated)', borderRadius: '99px', padding: '1px 8px', fontSize: '0.75rem', color: 'var(--text-secondary)', marginLeft: '8px' }}>
                                {remotePeers.length}
                            </span>
                        </span>
                    </div>
                    <div className="device-grid">
                        {remotePeers.map((peer) => (
                            <DeviceCard
                                key={peer.id}
                                peer={peer}
                                selected={selectedPeer}
                                onClick={() => setSelectedPeer((prev) => !prev)}
                            />
                        ))}
                    </div>
                </div>
            ) : (
                <div className="section">
                    <div className="empty-state">
                        <div className="empty-icon">🌍</div>
                        <p>No remote peer connected yet.</p>
                        <p style={{ marginTop: '4px' }}>Share your code or enter a peer's code above.</p>
                    </div>
                </div>
            )}

            {remotePeer && selectedPeer && (
                <div className="section">
                    <div className="section-header">
                        <span className="section-title">
                            Send to <strong style={{ color: 'var(--accent)' }}>{remotePeer.name}</strong>
                        </span>
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
