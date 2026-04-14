import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import Home from './pages/Home';
import Lan from './pages/Lan';
import Remote from './pages/Remote';
import { useAgentSocket } from './hooks/useAgentSocket';
import IncomingTransferModal from './components/IncomingTransferModal';

function AppShell() {
  const location = useLocation();
  const {
    connected,
    deviceName,
    incomingTransfer,
    transfers,
    sendFile,
    acceptTransfer,
    rejectTransfer,
    discoverPeers,
    peers,
    dismissIncoming,
  } = useAgentSocket();

  return (
    <div className="app">
      <nav className="navbar">
        <Link to="/" className="navbar-brand" style={{ textDecoration: 'none' }}>
          <span className="logo-dot" />
          <span>PeerDrop</span>
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
          <span className={`status-dot ${connected ? 'connected' : ''}`} />
          <span>{connected ? deviceName || 'Online' : 'Offline'}</span>
        </div>
      </nav>
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

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
