// ─────────────────────────────────────────────────────────────────────────
// LAN FEATURE — DISABLED (line-commented in place; preserved for re-enable).
// To restore: strip the leading "// " from every line below this header,
// then revert the related edits in App.tsx, Home.tsx, config.ts, types.ts.
// See README.md for the active Remote-only build.
// ─────────────────────────────────────────────────────────────────────────

// import { useState, useEffect, useCallback, useRef } from "react";
// import { agentSocket } from "../lib/agentSocket";
// import type { Peer, Transfer, AgentMessage } from "../types";
// 
// const TRANSFER_TTL_MS = 30 * 60 * 1000;
// const TRANSFER_MAP_MAX = 200;
// 
// interface AgentSocketState {
//   connected: boolean;
//   agentFailed: boolean;
//   deviceName: string;
//   deviceId: string;
//   peers: Peer[];
//   incomingTransfer: Transfer | null;
//   transfers: Map<string, Transfer>;
//   lastError: string | null;
//   sendFile: (peerId: string, file: File) => void;
//   acceptTransfer: (transferId: string) => void;
//   rejectTransfer: (transferId: string) => void;
//   discoverPeers: () => void;
//   dismissIncoming: () => void;
// }
// 
// /**
//  * Evict stale terminal transfers from the map.
//  * Two passes: TTL (drop terminal entries older than 30 min), then cap
//  * (if still over 200, drop oldest terminal entries; never evict active ones).
//  * Returns a new Map so React detects the change.
//  */
// function evictStaleTransfers(map: Map<string, Transfer>): Map<string, Transfer> {
//   const now = Date.now();
//   const next = new Map(map);
// 
//   for (const [id, t] of next) {
//     if (
//       (t.state === "completed" || t.state === "error" || t.state === "rejected") &&
//       t.completedAt &&
//       now - t.completedAt > TRANSFER_TTL_MS
//     ) {
//       next.delete(id);
//     }
//   }
// 
//   if (next.size > TRANSFER_MAP_MAX) {
//     const terminal = [...next.entries()]
//       .filter(([, t]) =>
//         t.state === "completed" || t.state === "error" || t.state === "rejected",
//       )
//       .sort(([, a], [, b]) => (a.completedAt ?? 0) - (b.completedAt ?? 0));
// 
//     for (const [id] of terminal) {
//       if (next.size <= TRANSFER_MAP_MAX) break;
//       next.delete(id);
//     }
//   }
// 
//   return next;
// }
// 
// export function useAgentSocket(): AgentSocketState {
//   const [connected, setConnected] = useState(false);
//   const [agentFailed, setAgentFailed] = useState(false);
//   const [deviceName, setDeviceName] = useState("");
//   const [deviceId, setDeviceId] = useState("");
//   const [peers, setPeers] = useState<Peer[]>([]);
//   const [incomingTransfer, setIncomingTransfer] = useState<Transfer | null>(null);
//   const [transfers, setTransfers] = useState<Map<string, Transfer>>(new Map());
//   const [lastError, setLastError] = useState<string | null>(null);
// 
//   const evictionTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
// 
//   useEffect(() => {
//     agentSocket.connect();
// 
//     // failed=true only arrives once max reconnect attempts are exhausted
//     const unsubStatus = agentSocket.onStatusChange((c, failed) => {
//       setConnected(c);
//       if (failed) setAgentFailed(true);
//     });
// 
//     const unsubMsg = agentSocket.onMessage((msg: AgentMessage) => {
//       switch (msg.type) {
//         case "agent_ready":
//           setDeviceName(msg.deviceName);
//           setDeviceId(msg.deviceId);
//           setAgentFailed(false);
//           setLastError(null);
//           break;
// 
//         case "peers_update": {
//           // Defensive dedup by id — mDNS announcements occasionally emit the
//           // same peer twice (separate IPv4/IPv6 SRV records). Last entry wins.
//           const unique = new Map<string, Peer>();
//           for (const p of msg.peers) unique.set(p.id, p);
//           setPeers([...unique.values()]);
//           break;
//         }
// 
//         case "transfer_offer":
//           setIncomingTransfer(msg.transfer);
//           break;
// 
//         case "transfer_update":
//           setTransfers((prev) => {
//             const next = new Map(prev);
//             next.set(msg.transfer.id, msg.transfer);
//             return evictStaleTransfers(next);
//           });
//           if (
//             msg.transfer.state === "completed" ||
//             msg.transfer.state === "error"
//           ) {
//             setIncomingTransfer(null);
//           }
//           break;
// 
//         case "error":
//           console.error("[Agent]", msg.code ?? "", msg.message);
//           setLastError(msg.message);
//           break;
//       }
//     });
// 
//     // Periodic eviction for low-activity sessions; high-activity sessions
//     // evict inline on every transfer_update.
//     evictionTimerRef.current = setInterval(() => {
//       setTransfers((prev) => evictStaleTransfers(prev));
//     }, 5 * 60 * 1000);
// 
//     return () => {
//       unsubStatus();
//       unsubMsg();
//       if (evictionTimerRef.current) clearInterval(evictionTimerRef.current);
//       agentSocket.disconnect();
//     };
//   }, []);
// 
//   const sendFile = useCallback((peerId: string, file: File) => {
//     agentSocket
//       .sendFileStream(peerId, file, (pct) => {
//         console.log(`[sendFile] ${file.name} → ${pct}%`);
//       })
//       .catch((err: Error) => {
//         console.error("[sendFile] Failed:", err);
//         setLastError(err.message);
//       });
//   }, []);
// 
//   const acceptTransfer = useCallback((transferId: string) => {
//     agentSocket.send({ type: "accept_transfer", transferId });
//     setIncomingTransfer(null);
//   }, []);
// 
//   const rejectTransfer = useCallback((transferId: string) => {
//     agentSocket.send({ type: "reject_transfer", transferId });
//     setIncomingTransfer(null);
//   }, []);
// 
//   const discoverPeers = useCallback(() => {
//     agentSocket.send({ type: "discover_peers" });
//   }, []);
// 
//   /**
//    * Dismiss the modal without responding. The 60-second auto-reject in the
//    * agent's PendingDecisionMap eventually cleans up the sender side — intentional
//    * so the user can accept via a different UI element later.
//    */
//   const dismissIncoming = useCallback(() => {
//     setIncomingTransfer(null);
//   }, []);
// 
//   return {
//     connected,
//     agentFailed,
//     deviceName,
//     deviceId,
//     peers,
//     incomingTransfer,
//     transfers,
//     lastError,
//     sendFile,
//     acceptTransfer,
//     rejectTransfer,
//     discoverPeers,
//     dismissIncoming,
//   };
// }

export {};
