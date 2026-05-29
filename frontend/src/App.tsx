import { BrowserRouter, Routes, Route, Link, Navigate } from 'react-router-dom';
import Remote from './pages/Remote';
import { ToastProvider } from './lib/toast';
import { useRemoteStatus } from './lib/remoteStatus';

// ─── LAN FEATURE — DISABLED ──────────────────────────────────────────────
// LAN mode (agent + mDNS + direct TCP) is preserved as line-commented files
// under backend/src/{api,discovery,transport,chunking,crypto} and frontend's
// useAgentSocket / agentSocket / pages/Lan / pages/Home. To re-enable:
//   1. Strip the leading "// " from each LAN file (see file headers).
//   2. Restore the imports below (Home, Lan, useAgentSocket,
//      IncomingTransferModal at app-root, the agentFailed banner, and the
//      LAN button + agent-status branch in the header).
// ──────────────────────────────────────────────────────────────────────────

function AppShell() {
  const remoteStatus = useRemoteStatus();

  // Single-mode header: just the relay/peer state.
  const headerStatus = remoteStatus.peerConnected
    ? { dot: 'connected', label: 'Peer connected' }
    : remoteStatus.relayConnected
      ? { dot: '', label: 'Waiting for peer' }
      : { dot: '', label: 'Connecting…' };

  return (
    <div className="app">
      <nav className="navbar">
        <Link to="/" className="navbar-brand" style={{ textDecoration: 'none' }}>
          <span className="logo-dot" />
          <span>NexDrop</span>
        </Link>

        <div className="navbar-status">
          <span className={`status-dot ${headerStatus.dot}`} />
          <span>{headerStatus.label}</span>
        </div>
      </nav>

      <main className="main-content">
        <Routes>
          <Route path="/" element={<Remote />} />
          {/* Legacy /remote path kept so any saved/shared link still works. */}
          <Route path="/remote" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

// Two components because useLocation()/useNavigate() must be descendants of BrowserRouter
export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </BrowserRouter>
  );
}
