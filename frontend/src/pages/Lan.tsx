import React from 'react';
import type { Peer, Transfer } from '../types';
import DeviceCard from '../components/DeviceCard';
import ProgressBar from '../components/ProgressBar';
import { formatBytes, formatState } from '../lib/utils';

interface LanProps {
    peers: Peer[];
    transfers: Map<string, Transfer>;
    agentConnected: boolean;
    onSendFile: (peerId: string, file: File) => void;
    onDiscover: () => void;
}

export default function Lan({ peers, transfers, agentConnected, onSendFile, onDiscover }: LanProps) {
    const [selectedPeer, setSelectedPeer] = React.useState<Peer | null>(null);
    const [dragging, setDragging] = React.useState(false);
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    function handleFileDrop(e: React.DragEvent) {
        e.preventDefault();
        setDragging(false);
        if (!selectedPeer) return;
        const file = e.dataTransfer.files[0];
        if (file) onSendFile(selectedPeer.id, file);
    }

    function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
        if (!selectedPeer) return;
        const file = e.target.files?.[0];
        if (file) onSendFile(selectedPeer.id, file);
        e.target.value = '';
    }

    const lanTransfers = Array.from(transfers.values()).filter((t) =>
        peers.some((p) => p.id === t.peerId)
    );

    return (
        <div>
            <div className="page-header">
                <h1>📡 LAN Transfer</h1>
                <p>
                    {agentConnected
                        ? 'Local agent connected — showing devices on your network.'
                        : 'Local agent is offline. Run `cd backend && npm run dev` to discover LAN peers.'}
                </p>
            </div>

            {/* Peer discovery */}
            <div className="section">
                <div className="section-header">
                    <span className="section-title">
                        <span>Devices on Network</span>
                        <span
                            style={{
                                background: 'var(--bg-elevated)',
                                borderRadius: '99px',
                                padding: '1px 8px',
                                fontSize: '0.75rem',
                                color: 'var(--text-secondary)',
                            }}
                        >
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

            {/* File drop zone (only if a peer is selected) */}
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
                    <input
                        ref={fileInputRef}
                        type="file"
                        style={{ display: 'none' }}
                        onChange={handleFileInput}
                    />
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
                            return (
                                <div className="transfer-item" key={t.id}>
                                    <span className="transfer-icon">
                                        {t.direction === 'send' ? '⬆️' : '⬇️'}
                                    </span>
                                    <div className="transfer-info">
                                        <div className="transfer-name">{t.fileName}</div>
                                        <div className="transfer-meta">
                                            {formatBytes(t.fileSize)} · {t.peerName} · {formatState(t.state)}
                                        </div>
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
