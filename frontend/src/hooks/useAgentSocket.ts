/**
 * useAgentSocket.ts
 * React hook that connects to the local Node.js agent via WebSocket.
 * Returns connection status, latest peers list, and incoming transfers.
 */

import { useState, useEffect, useCallback } from "react";
import { agentSocket } from "../lib/agentSocket";
import type { Peer, Transfer, AgentMessage } from "../types";

interface AgentSocketState {
  connected: boolean;
  deviceName: string;
  deviceId: string;
  peers: Peer[];
  incomingTransfer: Transfer | null;
  transfers: Map<string, Transfer>;
  sendFile: (peerId: string, file: File) => void;
  acceptTransfer: (transferId: string) => void;
  rejectTransfer: (transferId: string) => void;
  discoverPeers: () => void;
  dismissIncoming: () => void;
}

export function useAgentSocket(): AgentSocketState {
  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [peers, setPeers] = useState<Peer[]>([]);
  const [incomingTransfer, setIncomingTransfer] = useState<Transfer | null>(
    null,
  );
  const [transfers, setTransfers] = useState<Map<string, Transfer>>(new Map());

  useEffect(() => {
    agentSocket.connect();

    const unsubStatus = agentSocket.onStatusChange((c) => setConnected(c));

    const unsubMsg = agentSocket.onMessage((msg: AgentMessage) => {
      switch (msg.type) {
        case "agent_ready":
          setDeviceName(msg.deviceName);
          setDeviceId(msg.deviceId);
          break;
        case "peers_update":
          setPeers(msg.peers);
          break;
        case "transfer_offer":
          setIncomingTransfer(msg.transfer);
          break;
        case "transfer_update":
          setTransfers((prev) => {
            const next = new Map(prev);
            next.set(msg.transfer.id, msg.transfer);
            return next;
          });
          if (
            msg.transfer.state === "completed" ||
            msg.transfer.state === "error"
          ) {
            setIncomingTransfer(null);
          }
          break;
        case "error":
          console.error("[Agent]", msg.message);
          break;
      }
    });

    return () => {
      unsubStatus();
      unsubMsg();
      agentSocket.disconnect();
    };
  }, []);

  const sendFile = useCallback((peerId: string, file: File) => {
    // Use binary streaming — no base64, no memory blowup for large files
    agentSocket
      .sendFileStream(peerId, file, (pct) => {
        console.log(`[sendFile] ${file.name} → ${pct}%`);
      })
      .catch((err) => {
        console.error("[sendFile] Failed:", err);
      });
  }, []);

  const acceptTransfer = useCallback((transferId: string) => {
    agentSocket.send({ type: "accept_transfer", transferId });
    setIncomingTransfer(null);
  }, []);

  const rejectTransfer = useCallback((transferId: string) => {
    agentSocket.send({ type: "reject_transfer", transferId });
    setIncomingTransfer(null);
  }, []);

  const discoverPeers = useCallback(() => {
    agentSocket.send({ type: "discover_peers" });
  }, []);

  const dismissIncoming = useCallback(() => {
    setIncomingTransfer(null);
  }, []);

  return {
    connected,
    deviceName,
    deviceId,
    peers,
    incomingTransfer,
    transfers,
    sendFile,
    acceptTransfer,
    rejectTransfer,
    discoverPeers,
    dismissIncoming,
  };
}
