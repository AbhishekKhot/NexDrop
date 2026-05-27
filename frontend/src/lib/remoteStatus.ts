import { useSyncExternalStore } from 'react';

// Lightweight cross-component store so the Remote page can report its relay/peer
// connection to the app header without lifting useRemoteTransfer (which would
// otherwise open a relay connection on every page). Plain module store keeps
// this file component-export-free (avoids react-refresh lint).
export interface RemoteStatus {
  relayConnected: boolean;
  peerConnected: boolean;
}

let status: RemoteStatus = { relayConnected: false, peerConnected: false };
const listeners = new Set<() => void>();

export function setRemoteStatus(next: RemoteStatus): void {
  if (
    next.relayConnected === status.relayConnected &&
    next.peerConnected === status.peerConnected
  ) {
    return; // no change → keep the same snapshot reference
  }
  status = next;
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useRemoteStatus(): RemoteStatus {
  return useSyncExternalStore(subscribe, () => status);
}
