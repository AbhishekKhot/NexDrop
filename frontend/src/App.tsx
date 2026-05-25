import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import Home from './pages/Home';
import Lan from './pages/Lan';
import Remote from './pages/Remote';
import { useAgentSocket } from './hooks/useAgentSocket';
import IncomingTransferModal from './components/IncomingTransferModal';
import { ToastProvider, useToast } from './lib/toast';

function AppShell() {
  const location = useLocation();
  const { addToast } = useToast();
  const {
    connected,
    agentFailed,
    deviceName,
    lastError,
    incomingTransfer,
    transfers,
    sendFile,
    acceptTransfer,
    rejectTransfer,
    discoverPeers,
    peers,
    dismissIncoming,
  } = useAgentSocket();

  useEffect(() => {
    if (lastError) {
      addToast(lastError, 'error');
    }
  }, [lastError, addToast]);

  // agentFailed flips false → true exactly once per page load; banner stays visible since toast auto-dismisses after 5s
  useEffect(() => {
    if (agentFailed) {
      addToast(
        'Lost connection to the agent. Reload the page or restart `npm run dev` in the backend.',
        'error',
      );
    }
  }, [agentFailed, addToast]);

  return (
    <div className="app">
      <nav className="navbar">
        <Link to="/" className="navbar-brand" style={{ textDecoration: 'none' }}>
          <span className="logo-dot" />
          <span>NexDrop</span>
        </Link>

        <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
          <Link
            to="/lan"
            className="btn btn-outline btn-sm"
            style={location.pathname === '/lan' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
          >
            📡 LAN
          </Link>
          <Link
            to="/remote"
            className="btn btn-outline btn-sm"
            style={location.pathname === '/remote' ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
          >
            🌐 Remote
          </Link>
        </div>

        <div className="navbar-status">
          <span className={`status-dot ${connected ? 'connected' : agentFailed ? 'failed' : ''}`} />
          <span>
            {connected
              ? deviceName || 'Online'
              : agentFailed
                ? 'Agent unreachable'
                : 'Offline'}
          </span>
        </div>
      </nav>

      {agentFailed && (
        <div
          style={{
            background: '#2d1a1a',
            borderBottom: '1px solid #c0392b',
            color: '#e74c3c',
            padding: '0.5rem 1.5rem',
            fontSize: '0.85rem',
            textAlign: 'center',
          }}
        >
          ✕ Cannot connect to agent — LAN mode unavailable. Restart the backend with{' '}
          <code style={{ background: 'rgba(255,255,255,0.1)', padding: '1px 4px', borderRadius: '3px' }}>
            cd backend && npm run dev
          </code>{' '}
          then reload.
        </div>
      )}

      <main className="main-content">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route
            path="/lan"
            element={
              <Lan
                peers={peers.filter((p) => p.mode === 'lan')}
                transfers={transfers}
                agentConnected={connected}
                agentFailed={agentFailed}
                onSendFile={sendFile}
                onDiscover={discoverPeers}
              />
            }
          />
          <Route
            path="/remote"
            element={
              <Remote
                peers={peers.filter((p) => p.mode === 'remote')}
                transfers={transfers}
                agentConnected={connected}
                onSendFile={sendFile}
              />
            }
          />
        </Routes>
      </main>

      {/* Mounted at app-root level so it appears regardless of active route */}
      {incomingTransfer && (
        <IncomingTransferModal
          transfer={incomingTransfer}
          onAccept={() => acceptTransfer(incomingTransfer.id)}
          onReject={() => rejectTransfer(incomingTransfer.id)}
          onDismiss={dismissIncoming}
        />
      )}
    </div>
  );
}

// Two components because useLocation() must be a descendant of BrowserRouter
export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </BrowserRouter>
  );
}
