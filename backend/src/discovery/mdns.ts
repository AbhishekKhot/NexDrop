/**
 * mdns.ts
 * mDNS/Bonjour peer discovery for LAN mode.
 *
 * Each running NexDrop agent does two things simultaneously:
 *  1. Advertises itself so other agents on the LAN can find it.
 *  2. Browses for other peerdrop agents and maintains a live peer map.
 *
 * The peer map is the source of truth for which devices are available on the
 * local network.  Whenever it changes, the onChange callback fires and the WS
 * API broadcasts a peers_update message to all connected browser tabs.
 *
 * Key design decisions:
 *  - CPU-01: The onChange broadcast is debounced (300 ms) to collapse rapid
 *    mDNS churn.  Bonjour can fire multiple up/down events in quick succession
 *    when the network changes (e.g. a laptop waking from sleep announces several
 *    services at once).  Without debouncing, the browser would receive a burst
 *    of peers_update messages and re-render the peer list on each one.
 *
 *  - ERR-01: advertise() and browse() are wrapped in try/catch because Bonjour
 *    can fail on restricted networks (some corporate Wi-Fi blocks mDNS multicast).
 *    Instead of crashing the agent, errors are surfaced via the optional onError
 *    callback, which index.ts uses to broadcast an error toast to the browser.
 *
 *  - Self-filtering: the browser's own agent is excluded from the peer list using
 *    the deviceId (a UUID stable within the process lifetime).  Without this,
 *    a user would see their own device in the list and could try to send a file
 *    to themselves, which would work but is confusing UX.
 */

import Bonjour, { Browser, Service } from "bonjour-service";
import os from "os";
import { v4 as uuidv4 } from "uuid";
import {
  MDNS_SERVICE_TYPE,
  MDNS_PROTOCOL,
  TCP_PORT,
  DEVICE_NAME,
} from "../config";
import type { Peer } from "../types";

export type PeersChangeCallback = (peers: Peer[]) => void;
export type MdnsErrorCallback = (err: Error) => void;

export class MdnsService {
  private bonjour: Bonjour;
  private browser: Browser | null = null;

  /**
   * Live map of discovered peers keyed by their stable deviceId UUID.
   * Using a Map (not an array) makes add/remove O(1) regardless of peer count.
   */
  private peers: Map<string, Peer> = new Map();

  /**
   * Callback fired (debounced) whenever the peer map changes.
   * Injected by index.ts, which uses it to broadcast peers_update to browsers.
   */
  private onChange: PeersChangeCallback;

  /**
   * Optional error handler injected by index.ts — ERR-01.
   * If undefined, mDNS errors are only logged to console.
   */
  onError?: MdnsErrorCallback;

  /**
   * CPU-01: pending debounce timer handle.
   * Stored as a field so destroy() can cancel it if the service shuts down
   * while a debounce is in flight.
   */
  private debounceTimer: NodeJS.Timeout | null = null;

  /**
   * Stable UUID for this agent process.  Generated once at construction.
   * Sent in mDNS TXT records so other agents can filter out self-announcements.
   * Also broadcast to the browser in the agent_ready message.
   */
  readonly deviceId: string = uuidv4();

  constructor(onChange: PeersChangeCallback) {
    this.bonjour = new Bonjour();
    this.onChange = onChange;
  }

  /**
   * Schedule a debounced peer-list broadcast (CPU-01).
   *
   * Called from the Bonjour 'up' and 'down' event handlers.
   *
   * Why debounce instead of broadcasting immediately?
   * Bonjour can fire multiple service announcements in a very short window —
   * for example, a device that supports both IPv4 and IPv6 may emit two "up"
   * events in milliseconds.  Without debouncing, the browser receives redundant
   * peers_update messages and re-renders the peer list unnecessarily.
   *
   * The 300 ms window is long enough to absorb a burst of announcements but
   * short enough that the user sees the peer appear almost immediately.
   */
  private scheduleChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // Spread into an array so the callback can't mutate the internal Map
      this.onChange([...this.peers.values()]);
    }, 300);
  }

  /**
   * Publish this device on the LAN via mDNS so other agents can discover it.
   *
   * The service name includes a short slice of the deviceId to disambiguate
   * between multiple NexDrop instances running with the same DEVICE_NAME
   * (e.g. two machines both named "MacBook-Pro").
   *
   * TXT record fields:
   *  - deviceId:   stable UUID; used for self-filtering on remote agents
   *  - deviceName: human-readable label shown in the peer list
   *  - version:    protocol version hint (future compatibility)
   *
   * ERR-01: any Bonjour API failure is caught and forwarded to onError so
   * the agent doesn't crash — mDNS is unavailable on some restricted networks.
   */
  advertise(): void {
    try {
      this.bonjour.publish({
        name: `${DEVICE_NAME}-${this.deviceId.slice(0, 8)}`,
        type: MDNS_SERVICE_TYPE,
        protocol: MDNS_PROTOCOL,
        port: TCP_PORT,
        txt: {
          deviceId: this.deviceId,
          deviceName: DEVICE_NAME,
          version: "1",
        },
      });
      console.log(`[mDNS] Advertising as "${DEVICE_NAME}" on port ${TCP_PORT}`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[mDNS] Advertise failed:", error.message);
      this.onError?.(error);
    }
  }

  /**
   * Start listening for other peerdrop agents on the LAN.
   *
   * The 'up' event fires when a new service matching our type+protocol appears.
   * The 'down' event fires when a previously seen service disappears (device
   * left the network, went to sleep, or its agent was stopped).
   *
   * Edge case — self-filtering:
   * Bonjour will also announce our own service back to us.  We skip entries
   * where the TXT deviceId matches this.deviceId to avoid adding ourselves
   * to the peer list.
   *
   * Edge case — missing TXT data:
   * Some Bonjour implementations omit TXT records or return them as a Buffer.
   * The cast to Record<string, string> with optional chaining handles this
   * gracefully — a peer without a deviceId is silently ignored rather than
   * crashing the handler.
   *
   * ERR-01: wrapped in try/catch for the same reason as advertise().
   */
  browse(): void {
    try {
      this.browser = this.bonjour.find({
        type: MDNS_SERVICE_TYPE,
        protocol: MDNS_PROTOCOL,
      });

      this.browser.on("up", (service: Service) => {
        const peerId = (service.txt as Record<string, string>)?.deviceId;
        // Skip entries without a deviceId or matching our own device
        if (!peerId || peerId === this.deviceId) return;

        const peer: Peer = {
          id: peerId,
          name:
            (service.txt as Record<string, string>)?.deviceName ?? service.name,
          // service.addresses is a string[] of all interface addresses for this service
          // [0] is typically the primary address; for multi-homed hosts we take the first
          ip: service.addresses?.[0],
          port: service.port,
          mode: "lan",
          status: "available",
        };
        this.peers.set(peerId, peer);
        console.log(
          `[mDNS] Peer discovered: ${peer.name} @ ${peer.ip}:${peer.port}`,
        );
        this.scheduleChange(); // CPU-01: debounced broadcast
      });

      this.browser.on("down", (service: Service) => {
        const peerId = (service.txt as Record<string, string>)?.deviceId;
        if (peerId) {
          this.peers.delete(peerId);
          console.log(`[mDNS] Peer left: ${peerId}`);
          this.scheduleChange(); // CPU-01: debounced broadcast
        }
      });

      console.log("[mDNS] Browsing for peers…");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[mDNS] Browse failed:", error.message);
      this.onError?.(error);
    }
  }

  /**
   * Return a snapshot of currently known peers.
   *
   * Returns a new array each call (spread from the internal Map) so callers
   * can't accidentally mutate the service's state by holding a reference.
   */
  getPeers(): Peer[] {
    return [...this.peers.values()];
  }

  /**
   * Gracefully shut down mDNS advertising and browsing.
   *
   * Clears the debounce timer first to prevent a stale onChange() call from
   * firing after the Bonjour instance has been destroyed (which could crash
   * or cause confusing log output during shutdown).
   */
  destroy(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.browser?.stop();
    this.bonjour.unpublishAll();
    this.bonjour.destroy();
  }
}
