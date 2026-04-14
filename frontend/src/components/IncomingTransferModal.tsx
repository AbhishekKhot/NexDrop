import type { Transfer } from '../types';
import { formatBytes } from '../lib/utils';

interface Props {
    transfer: Transfer;
    onAccept: () => void;
    onReject: () => void;
    onDismiss: () => void;
}

export default function IncomingTransferModal({ transfer, onAccept, onReject, onDismiss }: Props) {
    return (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="incoming-modal-title">
            <div className="modal">
                <h2 id="incoming-modal-title">📥 Incoming File</h2>
                <p style={{ marginTop: '1rem', lineHeight: 1.7 }}>
                    <strong style={{ color: 'var(--text-primary)' }}>{transfer.peerName}</strong> wants to send you:
                </p>

                <div
                    style={{
                        marginTop: '1rem',
                        padding: '1rem',
                        background: 'var(--bg-elevated)',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                    }}
                >
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)', wordBreak: 'break-all' }}>
                        📄 {transfer.fileName}
                    </div>
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '4px' }}>
                        {formatBytes(transfer.fileSize)} · {transfer.totalChunks} chunks
                    </div>
                </div>

                <div style={{ marginTop: '1rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                    🔒 Transfer is end-to-end encrypted
                </div>

                <div className="modal-actions">
                    <button
                        id="accept-transfer-btn"
                        className="btn btn-success"
                        onClick={onAccept}
                    >
                        ✅ Accept
                    </button>
                    <button
                        id="reject-transfer-btn"
                        className="btn btn-danger"
                        onClick={onReject}
                    >
                        ✕ Reject
                    </button>
                </div>

                <button
                    onClick={onDismiss}
                    style={{
                        marginTop: '0.75rem',
                        width: '100%',
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-muted)',
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                        padding: '4px',
                    }}
                >
                    Decide later
                </button>
            </div>
        </div>
    );
}
