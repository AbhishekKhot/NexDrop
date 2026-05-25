import Bonjour, { Browser, Service } from "bonjour-service";
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

// IPv4 dotted-quad — matches well-formed addresses only; rejects mDNS quirks
// like trailing dots or interface suffixes.
const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

function pickReachableAddress(addresses: readonly string[]): string | undefined {
  const ipv4 = addresses.find((a) => IPV4_RE.test(a));
  if (ipv4) return ipv4;
  // Skip IPv6 link-local (fe80::/10) — needs a scope ID to be routable.
  return addresses.find((a) => !a.toLowerCase().startsWith("fe80:"));
}

export class MdnsService {
  private bonjour: Bonjour;
  private browser: Browser | null = null;

  private peers: Map<string, Peer> = new Map();

  private onChange: PeersChangeCallback;

  onError?: MdnsErrorCallback;

  private debounceTimer: NodeJS.Timeout | null = null;

  readonly deviceId: string = uuidv4();

  constructor(onChange: PeersChangeCallback) {
    this.bonjour = new Bonjour();
    this.onChange = onChange;
  }

  // Debounced because Bonjour can fire multiple service announcements in a
  // very short window (e.g. a device supporting both IPv4 and IPv6 emits two
  // "up" events in milliseconds). 300 ms absorbs the burst but is short enough
  // that the user sees the peer appear almost immediately.
  private scheduleChange(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      // Spread so the callback can't mutate the internal Map
      this.onChange([...this.peers.values()]);
    }, 300);
  }

  // wrapped in try/catch because Bonjour throws sync errors that would crash
  // the agent on restricted networks (some corporate Wi-Fi blocks mDNS multicast)
  advertise(): void {
    try {
      this.bonjour.publish({
        // Slice of deviceId disambiguates multiple instances with the same DEVICE_NAME
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

  browse(): void {
    try {
      this.browser = this.bonjour.find({
        type: MDNS_SERVICE_TYPE,
        protocol: MDNS_PROTOCOL,
      });

      this.browser.on("up", (service: Service) => {
        const peerId = (service.txt as Record<string, string>)?.deviceId;
        // Skip self-announcements and entries without a deviceId. Some Bonjour
        // implementations omit TXT records or return them as a Buffer; optional
        // chaining handles this gracefully rather than crashing the handler.
        if (!peerId || peerId === this.deviceId) return;

        // Prefer a non-link-local IPv4 address. fe80::/10 link-local IPv6
        // addresses are not usable for cross-host TCP without a scope ID, so
        // exposing them in the peer list would show a card that can't actually
        // be reached. Fall back to the first usable address if no IPv4 exists.
        const ip = pickReachableAddress(service.addresses ?? []);
        if (!ip) return;

        const peer: Peer = {
          id: peerId,
          name:
            (service.txt as Record<string, string>)?.deviceName ?? service.name,
          ip,
          port: service.port,
          mode: "lan",
          status: "available",
        };

        // Evict any stale peer at the same IP:port. When a peer restarts, its
        // new agent gets a fresh deviceId, but the old mDNS announcement can
        // linger on this side (multicast goodbye packets are lossy and the
        // record TTL can be tens of minutes). Without this, the user sees
        // both the old and new instance side-by-side until the TTL expires.
        for (const [existingId, existingPeer] of this.peers) {
          if (
            existingId !== peerId &&
            existingPeer.ip === peer.ip &&
            existingPeer.port === peer.port
          ) {
            this.peers.delete(existingId);
            console.log(
              `[mDNS] Evicted stale peer ${existingId.slice(0, 8)} @ ${existingPeer.ip}:${existingPeer.port} (replaced by ${peerId.slice(0, 8)})`,
            );
          }
        }

        this.peers.set(peerId, peer);
        console.log(
          `[mDNS] Peer discovered: ${peer.name} @ ${peer.ip}:${peer.port}`,
        );
        this.scheduleChange();
      });

      this.browser.on("down", (service: Service) => {
        const peerId = (service.txt as Record<string, string>)?.deviceId;
        if (peerId) {
          this.peers.delete(peerId);
          console.log(`[mDNS] Peer left: ${peerId}`);
          this.scheduleChange();
        }
      });

      console.log("[mDNS] Browsing for peers…");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[mDNS] Browse failed:", error.message);
      this.onError?.(error);
    }
  }

  getPeers(): Peer[] {
    // New array each call so callers can't mutate internal state
    return [...this.peers.values()];
  }

  destroy(): void {
    // Clear debounce first to prevent a stale onChange() call from firing
    // after the Bonjour instance has been destroyed.
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.browser?.stop();
    this.bonjour.unpublishAll();
    this.bonjour.destroy();
  }
}
