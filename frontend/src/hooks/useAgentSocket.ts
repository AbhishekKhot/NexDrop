/**
 * useAgentSocket.ts
 * React hook that manages the connection to the local NexDrop agent and
 * exposes its state to the component tree.
 *
 * This hook is the single source of truth for all LAN-mode state:
 *  - Connection status (connected, agentFailed)
 *  - Discovered LAN peers
 *  - In-progress and completed transfers
 *  - Incoming transfer offers
 *
 * It bridges the imperative agentSocket singleton (agentSocket.ts) with
 * React's declarative state model by translating WebSocket events into
 * setState calls.
 *
 * Fixes applied:
 *  MEM-01  — Evict completed/error/rejected transfers older than 30 min;
 *             hard-cap the Map at 200 entries to prevent unbounded growth
 *             during long-running sessions.
 *  QUAL-05 — Expose agentFailed state when max reconnect attempts exhausted,
 *             enabling the UI to render a permanent "agent unreachable" banner.
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { agentSocket } from "../lib/agentSocket";
import type { Peer, Transfer, AgentMessage } from "../types";

const TRANSFER_TTL_MS = 30 * 60 * 1000; // 30 minutes — MEM-01
const TRANSFER_MAP_MAX = 200;            // hard cap — MEM-01

interface AgentSocketState {
  connected: boolean;
  /** QUAL-05: true when the agent is permanently unreachable (max retries exhausted) */
  agentFailed: boolean;
  deviceName: string;
  deviceId: string;
  peers: Peer[];
  incomingTransfer: Transfer | null;
  transfers: Map<string, Transfer>;
  lastError: string | null;
  sendFile: (peerId: string, file: File) => void;
  acceptTransfer: (transferId: string) => void;
  rejectTransfer: (transferId: string) => void;
  discoverPeers: () => void;
  dismissIncoming: () => void;
}

/**
 * Evict stale terminal transfers from the transfer map — MEM-01.
 *
 * Why evict in a pure function rather than a useEffect?
 * The eviction is applied as part of the setTransfers update callback, which
 * lets us keep the Map from growing without adding a separate "cleanup" render
 * cycle.  A pure function is also easy to unit test in isolation.
 *
 * Two eviction strategies (applied in order):
 *  1. TTL eviction: remove transfers older than 30 min.
 *  2. Cap eviction: if still over 200, drop oldest completed entries first.
 *     Active (pending/transferring) entries are never evicted by the cap.
 *
 * Returns a new Map rather than mutating the input so React detects the change.
 */
function evictStaleTransfers(map: Map<string, Transfer>): Map<string, Transfer> {
  const now = Date.now();
  const next = new Map(map);

  // TTL pass: remove terminal transfers whose completedAt is too old
  for (const [id, t] of next) {
    if (
      (t.state === "completed" || t.state === "error" || t.state === "rejected") &&
      t.completedAt &&
      now - t.completedAt > TRANSFER_TTL_MS
    ) {
      next.delete(id);
    }
  }

  // Cap pass: if still over limit, drop oldest terminal entries
  if (next.size > TRANSFER_MAP_MAX) {
    const terminal = [...next.entries()]
      .filter(([, t]) =>
        t.state === "completed" || t.state === "error" || t.state === "rejected",
      )
      // Sort ascending by completedAt — oldest first, so we delete oldest first
      .sort(([, a], [, b]) => (a.completedAt ?? 0) - (b.completedAt ?? 0));

    for (const [id] of terminal) {
      if (next.size <= TRANSFER_MAP_MAX) break;
      next.delete(id);
    }
  }

  return next;
}

export function useAgentSocket(): AgentSocketState {
  const [connected, setConnected] = useState(false);
  const [agentFailed, setAgentFailed] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [incomingTransfer, setIncomingTransfer] = useState<Transfer | null>(null);
  const [transfers, setTransfers] = useState<Map<string, Transfer>>(new Map());
  const [lastError, setLastError] = useState<string | null>(null);

  /** MEM-01: ref to the periodic eviction interval so it can be cleared on unmount */
  const evictionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    agentSocket.connect();

    // Status handler: updates connected + agentFailed.
    // failed=true only arrives when max reconnect attempts are exhausted (QUAL-05).
    const unsubStatus = agentSocket.onStatusChange((c, failed) => {
      setConnected(c);
      if (failed) setAgentFailed(true);
    });

    const unsubMsg = agentSocket.onMessage((msg: AgentMessage) => {
      switch (msg.type) {
        case "agent_ready":
          // Reset failed state on successful reconnect — agent came back up
          setDeviceName(msg.deviceName);
          setDeviceId(msg.deviceId);
          setAgentFailed(false);
          setLastError(null);
          break;

        case "peers_update":
          // Full snapshot — replace the entire peer list, not just update deltas
          setPeers(msg.peers);
          break;

        case "transfer_offer":
          // Show the accept/reject modal for an incoming LAN transfer
          setIncomingTransfer(msg.transfer);
          break;

        case "transfer_update":
          setTransfers((prev) => {
            const next = new Map(prev);
            next.set(msg.transfer.id, msg.transfer);
            // Evict stale entries on every update so the Map never drifts large
            return evictStaleTransfers(next);
          });
          // Clear the incoming modal when the transfer reaches a terminal state
          // (the user accepted or the sender gave up)
          if (
            msg.transfer.state === "completed" ||
            msg.transfer.state === "error"
          ) {
            setIncomingTransfer(null);
          }
          break;

        case "error":
          console.error("[Agent]", msg.code ?? "", msg.message);
          setLastError(msg.message);
          break;
      }
    });

    // MEM-01: periodic eviction every 5 minutes for sessions with low transfer activity
    // (in high-activity sessions, eviction happens inline with every transfer_update)
    evictionTimerRef.current = setInterval(() => {
      setTransfers((prev) => evictStaleTransfers(prev));
    }, 5 * 60 * 1000);

    return () => {
      unsubStatus();
      unsubMsg();
      if (evictionTimerRef.current) clearInterval(evictionTimerRef.current);
      agentSocket.disconnect();
    };
  }, []); // empty deps: run once on mount, clean up on unmount

  /**
   * Initiate a file send to a LAN peer.
   *
   * sendFileStream() goes through the serial queue (LOAD-02) so concurrent
   * calls don't interleave their binary chunk frames.
   *
   * Errors (file too large, agent not connected) are caught and stored in
   * lastError so App.tsx can surface them as a toast notification (ERR-05).
   */
  const sendFile = useCallback((peerId: string, file: File) => {
    agentSocket
      .sendFileStream(peerId, file, (pct) => {
        console.log(`[sendFile] ${file.name} → ${pct}%`);
      })
      .catch((err: Error) => {
        console.error("[sendFile] Failed:", err);
        setLastError(err.message);
      });
  }, []);

  /**
   * Accept an incoming transfer offer.
   * Sends accept_transfer to the agent and clears the modal immediately
   * so the user can interact with the rest of the UI while the transfer runs.
   */
  const acceptTransfer = useCallback((transferId: string) => {
    agentSocket.send({ type: "accept_transfer", transferId });
    setIncomingTransfer(null);
  }, []);

  /**
   * Reject an incoming transfer offer.
   * The agent propagates the rejection to the sender's TCP connection.
   */
  const rejectTransfer = useCallback((transferId: string) => {
    agentSocket.send({ type: "reject_transfer", transferId });
    setIncomingTransfer(null);
  }, []);

  /**
   * Request an immediate mDNS peer list snapshot from the agent.
   * Called when the user clicks the "Scan" button in the LAN view.
   */
  const discoverPeers = useCallback(() => {
    agentSocket.send({ type: "discover_peers" });
  }, []);

  /**
   * Dismiss the incoming transfer modal without accepting or rejecting.
   *
   * Edge case: the transfer offer is still pending on the agent side after dismissal.
   * The 60-second auto-reject timeout in PendingDecisionMap will eventually clean it up.
   * This is intentional — the user may want to accept via a different UI element later.
   */
  const dismissIncoming = useCallback(() => {
    setIncomingTransfer(null);
  }, []);

  return {
    connected,
    agentFailed,
    deviceName,
    deviceId,
    peers,
    incomingTransfer,
    transfers,
    lastError,
    sendFile,
    acceptTransfer,
    rejectTransfer,
    discoverPeers,
    dismissIncoming,
  };
}
