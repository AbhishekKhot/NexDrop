/**
 * App.tsx
 * Root component for the NexDrop browser UI.
 *
 * Responsibilities:
 *  1. Wrap the entire app in <BrowserRouter> for client-side routing.
 *  2. Wrap in <ToastProvider> so every component can call useToast() without
 *     prop drilling — the provider must sit above AppShell, which uses the hook.
 *  3. Own the single useAgentSocket() call so the WebSocket connection is created
 *     once at the top of the tree and shared downward via props.  A second call in
 *     a child component would create a second WebSocket connection.
 *  4. Translate imperative agent events (lastError, agentFailed) into declarative
 *     toast notifications so users get visible feedback rather than silent failures.
 *
 * Why two components (App + AppShell)?
 * useLocation() can only be called inside a component that is a descendant of
 * <BrowserRouter>.  AppShell is that descendant; App just provides the Router
 * and Provider wrappers.  Merging them would require hoisting BrowserRouter higher,
 * which would complicate testing.
 *
 * Fixes applied:
 *  ERR-05 — ToastProvider wraps the app; agent errors surface via useToast
 *  QUAL-05 — agentFailed banner shown when max reconnect attempts exhausted
 */

import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom';
import { useEffect } from 'react';
import Home from './pages/Home';
import Lan from './pages/Lan';
import Remote from './pages/Remote';
import { useAgentSocket } from './hooks/useAgentSocket';
import IncomingTransferModal from './components/IncomingTransferModal';
import { ToastProvider, useToast } from './lib/toast';

/**
 * AppShell — inner component that has access to both the Router context (for
 * useLocation) and the Toast context (for useToast).
 *
 * Owns the agent WebSocket state for the entire session.  All page-level
 * components (Lan, Remote) receive their data as props from here, keeping the
 * WebSocket connection at a single stable point regardless of route changes.
 */
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

  /**
   * ERR-05: Surface agent errors (WebSocket send failures, file-too-large, etc.)
   * as toast notifications.
   *
   * Why useEffect with [lastError] dep instead of calling addToast directly in
   * the hook's sendFile callback?  The hook runs outside of React's render cycle
   * when the Promise rejects; calling setState (addToast) from a Promise reject
   * that fires in a non-React context still works, but the dependency-array pattern
   * makes the data flow explicit and testable.
   *
   * addToast is stable (useCallback with [] deps) so it never causes re-runs.
   */
  useEffect(() => {
    if (lastError) {
      addToast(lastError, 'error');
    }
  }, [lastError, addToast]);

  /**
   * QUAL-05: Surface permanent connection failure as a toast AND show a persistent
   * banner below the navbar.
   *
   * Why both toast AND banner?
   * The toast auto-dismisses after 5 seconds.  If the user is looking elsewhere
   * when it fires, they might miss it.  The banner stays visible until the page
   * is reloaded, making the unreachable state unmistakable.
   *
   * agentFailed transitions from false → true exactly once per page load (it is
   * never reset unless the agent sends agent_ready on reconnect).  The effect
   * fires exactly once when the flag flips, so the toast appears once only.
   */
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
      {/*
       * Navbar: three-column layout — brand left, nav links centre, status right.
       *
       * Active route highlighting: compare location.pathname to the link's target
       * and apply accent-coloured inline styles.  This avoids importing a NavLink
       * component or adding a CSS class just for active state.
       *
       * Status indicator (navbar-status):
       *  - connected=true  → green dot + device name (from agent_ready message)
       *  - agentFailed=true → red dot + "Agent unreachable"
       *  - neither          → grey dot + "Offline" (connecting/reconnecting)
       */}
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
          {/* Three-state dot: connected (green), failed (red), offline (grey) */}
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

      {/*
       * QUAL-05: Persistent error banner when agent reconnection is exhausted.
       *
       * Why a banner in addition to the toast?
       * The toast auto-dismisses after 5 seconds.  A persistent banner ensures
       * the user cannot miss that LAN mode is permanently unavailable without
       * a page reload.  The banner is only rendered when agentFailed=true, which
       * is set exactly once (when max reconnect attempts are exhausted) and never
       * reset unless the page is reloaded and a fresh agent_ready is received.
       */}
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
        {/*
         * Route → page mapping:
         *  /       → Home (splash / mode picker)
         *  /lan    → Lan  (LAN peer list + transfer UI)
         *  /remote → Remote (WebRTC peer + transfer UI)
         *
         * Peers are pre-filtered by mode before passing to each page so that Lan
         * never sees remote-mode peers and vice versa.  The transfers Map is passed
         * whole — pages filter to their own peers via t.peerId lookup.
         */}
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

      {/*
       * IncomingTransferModal: rendered at app-root level (not inside a route)
       * so it appears regardless of which page is active when a transfer offer arrives.
       *
       * Conditional rendering: only mount the modal when incomingTransfer is non-null.
       * This avoids the component registering event listeners when idle.
       *
       * The modal captures the current incomingTransfer in its closure for the accept/
       * reject callbacks — React guarantees the closure is fresh because the entire
       * JSX subtree is re-evaluated whenever incomingTransfer changes.
       */}
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

/**
 * App — outermost component.
 *
 * Provides the two context trees that the entire application depends on:
 *  1. BrowserRouter: enables useLocation, useNavigate, and <Link> throughout the tree.
 *  2. ToastProvider: enables useToast() in any descendant without prop drilling.
 *
 * AppShell is rendered inside both providers so it can consume them.
 *
 * Why not merge App and AppShell?
 * useLocation() throws if called outside a Router descendant.  Putting it in the
 * same component that renders <BrowserRouter> would mean the hook runs before the
 * Router context is available.  The two-component pattern is the standard React
 * Router idiom for this constraint.
 */
export default function App() {
  return (
    <BrowserRouter>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </BrowserRouter>
  );
}
