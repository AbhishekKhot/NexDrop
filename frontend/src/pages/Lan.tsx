// ─────────────────────────────────────────────────────────────────────────
// LAN FEATURE — DISABLED (line-commented in place; preserved for re-enable).
// To restore: strip the leading "// " from every line below this header,
// then revert the related edits in App.tsx, Home.tsx, config.ts, types.ts.
// See README.md for the active Remote-only build.
// ─────────────────────────────────────────────────────────────────────────

// import React, { useRef, useEffect } from 'react';
// import type { Peer, Transfer } from '../types';
// import DeviceCard from '../components/DeviceCard';
// import ProgressBar from '../components/ProgressBar';
// import { formatBytes, formatState, formatSpeed, formatETA } from '../lib/utils';
// import { useToast } from '../lib/toast';
// 
// interface LanProps {
//     peers: Peer[];
//     transfers: Map<string, Transfer>;
//     agentConnected: boolean;
//     agentFailed?: boolean;
//     onSendFile: (peerId: string, file: File) => void;
//     onDiscover: () => void;
// }
// 
// interface SpeedSample {
//     lastChunks: number;
//     lastAt: number;
//     bytesPerSec: number;
// }
// 
// export default function Lan({ peers, transfers, agentConnected, agentFailed, onSendFile, onDiscover }: LanProps) {
//     const { addToast } = useToast();
//     const [selectedPeer, setSelectedPeer] = React.useState<Peer | null>(null);
//     const [dragging, setDragging] = React.useState(false);
//     const fileInputRef = React.useRef<HTMLInputElement>(null);
// 
//     // Stored in ref (not state) so EMA updates don't trigger extra renders
//     const speedSamples = useRef<Map<string, SpeedSample>>(new Map());
// 
//     // Runs every render intentionally — transfers prop changes on every transfer_update message
//     useEffect(() => {
//         for (const id of speedSamples.current.keys()) {
//             const t = transfers.get(id);
//             if (!t || t.state !== 'transferring') {
//                 speedSamples.current.delete(id);
//             }
//         }
//     });
// 
//     function handleFileDrop(e: React.DragEvent) {
//         e.preventDefault();
//         setDragging(false);
//         if (!selectedPeer) return;
//         const file = e.dataTransfer.files[0];
//         if (file) sendFile(selectedPeer.id, file);
//     }
// 
//     function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
//         if (!selectedPeer) return;
//         const file = e.target.files?.[0];
//         if (file) sendFile(selectedPeer.id, file);
//         // Reset so selecting the same file twice in a row still fires onChange
//         e.target.value = '';
//     }
// 
//     // onSendFile can throw synchronously (e.g. "agent not connected") before its Promise is created
//     function sendFile(peerId: string, file: File) {
//         try {
//             onSendFile(peerId, file);
//         } catch (err) {
//             const msg = err instanceof Error ? err.message : String(err);
//             addToast(msg, 'error');
//         }
//     }
// 
//     // Receive transfers carry the sender's IP as peerId (set in tcpServer.ts),
//     // which never matches a peer card's deviceId UUID — so any peer-match filter
//     // hides incoming transfers entirely. Show every transfer; eviction in
//     // useAgentSocket already prunes stale terminal entries.
//     const lanTransfers = Array.from(transfers.values());
// 
//     // EMA (α = 0.3) sampled at ≥1s intervals; chunkBytes uses fileSize/totalChunks because the final chunk may be smaller
//     function getSpeedETA(t: Transfer): { speed: string; eta: string } | null {
//         if (t.state !== 'transferring' || t.totalChunks === 0) return null;
// 
//         const chunkBytes = t.fileSize / t.totalChunks;
//         const now = Date.now();
//         let sample = speedSamples.current.get(t.id);
// 
//         if (!sample) {
//             sample = { lastChunks: t.chunksReceived, lastAt: now, bytesPerSec: 0 };
//             speedSamples.current.set(t.id, sample);
//         } else {
//             const elapsed = (now - sample.lastAt) / 1000;
//             if (elapsed >= 1) {
//                 const deltaBytesPerSec = ((t.chunksReceived - sample.lastChunks) * chunkBytes) / elapsed;
//                 sample.bytesPerSec = sample.bytesPerSec === 0
//                     ? deltaBytesPerSec
//                     : sample.bytesPerSec * 0.7 + deltaBytesPerSec * 0.3;
//                 sample.lastChunks = t.chunksReceived;
//                 sample.lastAt = now;
//             }
//         }
// 
//         if (sample.bytesPerSec === 0) return null;
//         const remaining = (t.totalChunks - t.chunksReceived) * chunkBytes;
//         return { speed: formatSpeed(sample.bytesPerSec), eta: formatETA(remaining, sample.bytesPerSec) };
//     }
// 
//     return (
//         <div>
//             <div className="page-header">
//                 <h1>📡 LAN Transfer</h1>
//                 <p>
//                     {agentFailed
//                         ? 'Agent unreachable — restart the backend and reload.'
//                         : agentConnected
//                             ? 'Local agent connected — showing devices on your network.'
//                             : 'Local agent is offline. Run `cd backend && npm run dev` to discover LAN peers.'}
//                 </p>
//             </div>
// 
//             <div className="section">
//                 <div className="section-header">
//                     <span className="section-title">
//                         <span>Devices on Network</span>
//                         <span style={{ background: 'var(--bg-elevated)', borderRadius: '99px', padding: '1px 8px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
//                             {peers.length}
//                         </span>
//                     </span>
//                     <button className="btn btn-outline btn-sm" onClick={onDiscover} disabled={!agentConnected}>
//                         <span>🔍</span> Scan
//                     </button>
//                 </div>
// 
//                 {peers.length === 0 ? (
//                     <div className="empty-state">
//                         <div className="empty-icon">📭</div>
//                         <p>No devices found on LAN yet.</p>
//                         <p style={{ marginTop: '4px' }}>Make sure the agent is running and click Scan.</p>
//                     </div>
//                 ) : (
//                     <div className="device-grid">
//                         {peers.map((peer) => (
//                             <DeviceCard
//                                 key={peer.id}
//                                 peer={peer}
//                                 selected={selectedPeer?.id === peer.id}
//                                 onClick={() => setSelectedPeer((prev) => (prev?.id === peer.id ? null : peer))}
//                             />
//                         ))}
//                     </div>
//                 )}
//             </div>
// 
//             {selectedPeer && (
//                 <div className="section">
//                     <div className="section-header">
//                         <span className="section-title">
//                             Send to <strong style={{ color: 'var(--accent)' }}>{selectedPeer.name}</strong>
//                         </span>
//                         <button className="btn btn-outline btn-sm" onClick={() => setSelectedPeer(null)}>
//                             ✕ Deselect
//                         </button>
//                     </div>
// 
//                     <div
//                         id="lan-drop-zone"
//                         className={`drop-zone ${dragging ? 'drag-over' : ''}`}
//                         onClick={() => fileInputRef.current?.click()}
//                         onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
//                         onDragLeave={() => setDragging(false)}
//                         onDrop={handleFileDrop}
//                     >
//                         <span className="drop-icon">📁</span>
//                         <p>Drag &amp; drop a file here, or <strong>click to browse</strong></p>
//                     </div>
//                     <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleFileInput} />
//                 </div>
//             )}
// 
//             {lanTransfers.length > 0 && (
//                 <div className="section">
//                     <div className="section-header">
//                         <span className="section-title">Transfers</span>
//                     </div>
//                     <div className="transfer-list">
//                         {lanTransfers.map((t) => {
//                             const pct = t.totalChunks > 0 ? Math.round((t.chunksReceived / t.totalChunks) * 100) : 0;
//                             const speedETA = getSpeedETA(t);
//                             return (
//                                 <div className="transfer-item" key={t.id}>
//                                     <span className="transfer-icon">{t.direction === 'send' ? '⬆️' : '⬇️'}</span>
//                                     <div className="transfer-info">
//                                         <div className="transfer-name">{t.fileName}</div>
//                                         <div className="transfer-meta">
//                                             {formatBytes(t.fileSize)} · {t.peerName} · {formatState(t.state)}
//                                             {speedETA && (
//                                                 <span style={{ marginLeft: '0.5rem', color: 'var(--text-muted)' }}>
//                                                     · {speedETA.speed} · {speedETA.eta} left
//                                                 </span>
//                                             )}
//                                         </div>
//                                         {t.state === 'error' && t.errorMessage && (
//                                             <div style={{ fontSize: '0.75rem', color: '#e74c3c', marginTop: '2px' }}>
//                                                 {t.errorMessage}
//                                             </div>
//                                         )}
//                                         {t.state === 'transferring' && (
//                                             <div className="progress-bar-wrapper">
//                                                 <ProgressBar percent={pct} />
//                                             </div>
//                                         )}
//                                     </div>
//                                     <span className={`tag tag-${t.state === 'completed' ? 'success' : t.state === 'error' ? 'error' : t.state === 'transferring' ? 'progress' : 'pending'}`}>
//                                         {t.state === 'transferring' ? `${pct}%` : t.state}
//                                     </span>
//                                 </div>
//                             );
//                         })}
//                     </div>
//                 </div>
//             )}
//         </div>
//     );
// }

export {};
