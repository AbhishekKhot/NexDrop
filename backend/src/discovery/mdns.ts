/**
 * mdns.ts
 * mDNS/Bonjour peer discovery for LAN mode.
 *
 * Each running agent:
 *  1. Publishes itself via mDNS so other agents on the LAN can find it.
 *  2. Browses for other peerdrop agents and maintains a live peer list.
 *
 * Uses the `bonjour-service` package (a maintained fork of the original bonjour).
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

export class MdnsService {
  private bonjour: Bonjour;
  private browser: Browser | null = null;
  private peers: Map<string, Peer> = new Map();
  private onChange: PeersChangeCallback;

  /** Unique ID for this device — stays stable within the process lifetime */
  readonly deviceId: string = uuidv4();

  constructor(onChange: PeersChangeCallback) {
    this.bonjour = new Bonjour();
    this.onChange = onChange;
  }

  /** Advertise this device on the LAN */
  advertise(): void {
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
  }

  /** Start browsing for other peerdrop agents on the LAN */
  browse(): void {
    this.browser = this.bonjour.find({
      type: MDNS_SERVICE_TYPE,
      protocol: MDNS_PROTOCOL,
    });

    this.browser.on("up", (service: Service) => {
      const peerId = (service.txt as Record<string, string>)?.deviceId;
      if (!peerId || peerId === this.deviceId) return; // skip self

      const peer: Peer = {
        id: peerId,
        name:
          (service.txt as Record<string, string>)?.deviceName ?? service.name,
        ip: service.addresses?.[0],
        port: service.port,
        mode: "lan",
        status: "available",
      };
      this.peers.set(peerId, peer);
      console.log(
        `[mDNS] Peer discovered: ${peer.name} @ ${peer.ip}:${peer.port}`,
      );
      this.onChange([...this.peers.values()]);
    });

    this.browser.on("down", (service: Service) => {
      const peerId = (service.txt as Record<string, string>)?.deviceId;
      if (peerId) {
        this.peers.delete(peerId);
        console.log(`[mDNS] Peer left: ${peerId}`);
        this.onChange([...this.peers.values()]);
      }
    });

    console.log("[mDNS] Browsing for peers…");
  }

  /** Return current snapshot of discovered peers */
  getPeers(): Peer[] {
    return [...this.peers.values()];
  }

  /** Graceful shutdown */
  destroy(): void {
    this.browser?.stop();
    this.bonjour.unpublishAll();
    this.bonjour.destroy();
  }
}
