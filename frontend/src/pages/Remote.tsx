import React, { useEffect } from 'react';
import type { Peer, Transfer } from '../types';
import DeviceCard from '../components/DeviceCard';
import ProgressBar from '../components/ProgressBar';
import IncomingTransferModal from '../components/IncomingTransferModal';
import { formatBytes, formatState } from '../lib/utils';
import { useRemoteTransfer } from '../hooks/useRemoteTransfer';

interface RemoteProps {
    peers?: Peer[]; // Ignoring global LAN peers for Remote mode
    transfers?: Map<string, Transfer>;
    agentConnected?: boolean;
    onSendFile?: (peerId: string, file: File) => void;
}

export default function Remote(_props: RemoteProps) {
    const [selectedPeer, setSelectedPeer] = React.useState<Peer | null>(null);
    const [dragging, setDragging] = React.useState(false);
    const [inputShareCode, setInputShareCode] = React.useState('');
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    
    const { 
        shareCode: localShareCode, 
        remotePeer, 
        transfers, 
        incomingTransfer,
        createRoom, 
        joinRoom, 
        sendRemoteFile, 
        acceptRemoteTransfer,
        rejectRemoteTransfer,
        dismissIncoming,
        disconnect 
    } = useRemoteTransfer();

    useEffect(() => {
        // Auto-create room when mounting
        createRoom();
        return () => disconnect();
    }, [createRoom, disconnect]);

    function handleFileDrop(e: React.DragEvent) {
        e.preventDefault();
        setDragging(false);
        if (!remotePeer) return;
        const file = e.dataTransfer.files[0];
        if (file) sendRemoteFile(file);
    }

    function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
        if (!remotePeer) return;
        const file = e.target.files?.[0];
        if (file) sendRemoteFile(file);
        e.target.value = '';
    }

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

            {/* Share code / connect */}
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
                        onClick={() => {
                            joinRoom(inputShareCode.trim());
                        }}
                    >
                        Connect
                    </button>
                </div>
                <p style={{ marginTop: '8px', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    Share your code with the other person: <strong style={{ color: 'var(--accent)', letterSpacing: '1px' }}>
                        {localShareCode || 'Generating...'}
                    </strong>
                </p>
            </div>

            {/* Connected remote peers */}
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

            {remotePeers.length === 0 && (
                <div className="section">
                    <div className="empty-state">
                        <div className="empty-icon">🌍</div>
                        <p>No remote peers connected yet.</p>
                        <p style={{ marginTop: '4px' }}>Share your code or enter a peer's code above.</p>
                    </div>
                </div>
            )}

            {/* File send zone */}
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
                    <input
                        ref={fileInputRef}
                        type="file"
                        style={{ display: 'none' }}
                        onChange={handleFileInput}
                    />
                </div>
            )}

            {/* Transfer list */}
            {remoteTransfers.length > 0 && (
                <div className="section">
                    <div className="section-header">
                        <span className="section-title">Transfers</span>
                    </div>
                    <div className="transfer-list">
                        {remoteTransfers.map((t) => {
                            const pct = t.totalChunks > 0 ? Math.round((t.chunksReceived / t.totalChunks) * 100) : 0;
                            return (
                                <div className="transfer-item" key={t.id}>
                                    <span className="transfer-icon">{t.direction === 'send' ? '⬆️' : '⬇️'}</span>
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
                                    <span className={`tag tag-${t.state === 'completed' ? 'success' : (t.state === 'error' || t.state === 'rejected') ? 'error' : t.state === 'transferring' ? 'progress' : 'pending'}`}>
                                        {t.state === 'transferring' ? `${pct}%` 
                                         : t.state === 'completed' ? (t.direction === 'send' ? 'Sent successfully' : 'Downloaded successfully')
                                         : t.state === 'rejected' ? 'Rejected by peer'
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
