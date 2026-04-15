/**
 * webrtc.ts
 * RTCPeerConnection wrapper for WebRTC DataChannel file transfer.
 *
 * Abstracts the low-level WebRTC API into two roles:
 *  Sender   (initiator)  — calls initiateSender()  → creates DataChannel + offer
 *  Receiver (joiner)     — calls initiateReceiver() → accepts offer + creates answer
 *
 * All file bytes flow through the DataChannel after the connection is established.
 * The signaling server (signalingServer.ts) only exchanges the SDP and ICE candidates
 * needed to set up the connection — it never sees any file bytes.
 *
 * Encryption: WebRTC DataChannels are always DTLS-encrypted by the browser.
 * NexDrop adds an additional application-layer ECDH + AES-256-GCM layer on top
 * (see remoteCrypto.ts and useRemoteTransfer.ts) for end-to-end encryption that
 * the signaling server cannot decrypt even in theory.
 *
 * Fix applied:
 *  MEM-03 — close() nulls out all event handler references to prevent stale
 *            callbacks and listener accumulation across reconnect cycles.
 *            Without this, a re-used P2PConnection instance could fire handlers
 *            from a previous session after the new session's handlers are set.
 */

/**
 * Build the ICE server list from environment variables.
 *
 * Reads VITE_STUN_SERVERS (comma-separated URLs) and, if provided,
 * VITE_TURN_SERVER_URL + credentials.
 *
 * Why build at module load time rather than inside the P2PConnection constructor?
 * The STUN list is the same for all connections within a page session, so
 * building it once and reusing the result avoids redundant env lookups.
 *
 * The return type annotation `: RTCIceServer` on the map callback is required
 * because without it TypeScript infers `{ urls: string }[]` — too narrow to
 * accept the additional `username` and `credential` fields pushed for TURN.
 */
function buildIceServers(): RTCIceServer[] {
  const stunList = (
    (import.meta as unknown as { env: Record<string, string> }).env
      .VITE_STUN_SERVERS ||
    "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
  )
    .split(",")
    .map((url: string): RTCIceServer => ({ urls: url.trim() }));

  const turnUrl = (import.meta as unknown as { env: Record<string, string> })
    .env.VITE_TURN_SERVER_URL as string | undefined;

  if (turnUrl) {
    // Push TURN config as a separate entry — allows mixing STUN-only and
    // STUN+TURN entries in the same ICE server list, which is the correct
    // way to configure WebRTC for maximum connectivity.
    stunList.push({
      urls: turnUrl,
      username: (import.meta as unknown as { env: Record<string, string> }).env
        .VITE_TURN_USERNAME as string | undefined,
      credential: (import.meta as unknown as { env: Record<string, string> })
        .env.VITE_TURN_CREDENTIAL as string | undefined,
    });
  }

  return stunList;
}

/** Shared ICE configuration used by all P2PConnection instances */
export const STUN_SERVERS: RTCConfiguration = {
  iceServers: buildIceServers(),
};

export type DataChannelMessageHandler = (data: ArrayBuffer | string) => void;
export type DataChannelStateHandler = (state: RTCDataChannelState) => void;

/**
 * Wrapper around RTCPeerConnection + RTCDataChannel for a single P2P session.
 *
 * One P2PConnection represents one WebRTC peer-to-peer link.  When the user
 * disconnects or a new session is needed, call close() and create a new instance.
 *
 * Handler registration (onData, onChannelState) must be called before
 * initiateSender() or initiateReceiver() so they are in place when the
 * DataChannel opens.
 */
export class P2PConnection {
  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;

  /**
   * Application-level data and state handlers.
   * Stored as instance fields (not directly on the DataChannel) so they can
   * be set before the DataChannel is created and survive DataChannel rebinding
   * (e.g. when the receiver's ondatachannel event fires).
   */
  private onDataHandler?: DataChannelMessageHandler;
  private onStateHandler?: DataChannelStateHandler;

  constructor(config: RTCConfiguration = STUN_SERVERS) {
    this.pc = new RTCPeerConnection(config);
    this._setupConnectionLogging();
  }

  /**
   * Sender role: create the DataChannel and an SDP offer.
   *
   * Must be called after onData() and onChannelState() are set, because the
   * DataChannel open event can fire before the ICE gathering completes.
   *
   * ordered:true ensures chunks arrive in order — critical for correct file
   * reassembly without a separate reordering buffer.
   *
   * @param onIceCandidate  Called for each local ICE candidate discovered;
   *                        caller sends these to the peer via the signaling server.
   * @returns               The SDP offer to be relayed to the receiver.
   */
  async initiateSender(
    onIceCandidate: (candidate: RTCIceCandidateInit) => void,
  ): Promise<RTCSessionDescriptionInit> {
    this.dataChannel = this.pc.createDataChannel("file-transfer", {
      ordered: true, // preserve chunk order; trades some latency for correctness
    });
    this._bindDataChannelEvents(this.dataChannel);

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        onIceCandidate(event.candidate.toJSON());
      }
    };

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return offer;
  }

  /**
   * Receiver role: accept the sender's SDP offer and create an answer.
   *
   * The DataChannel is created by the sender and delivered here via the
   * ondatachannel event.  We bind our handlers when it arrives.
   *
   * @param offer           SDP offer received from the sender via signaling.
   * @param onIceCandidate  Called for each local ICE candidate; relayed to sender.
   * @returns               The SDP answer to send back to the sender.
   */
  async initiateReceiver(
    offer: RTCSessionDescriptionInit,
    onIceCandidate: (candidate: RTCIceCandidateInit) => void,
  ): Promise<RTCSessionDescriptionInit> {
    // The sender creates the DataChannel; we receive it here via ondatachannel
    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this._bindDataChannelEvents(this.dataChannel);
    };

    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        onIceCandidate(event.candidate.toJSON());
      }
    };

    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return answer;
  }

  /**
   * Apply the remote peer's SDP answer (called on the sender after receiving
   * the receiver's answer from the signaling server).
   */
  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
  }

  /**
   * Add a remote ICE candidate (trickle ICE — both sides call this as
   * candidates arrive from the signaling server).
   */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  /**
   * Send raw bytes or a string through the DataChannel.
   *
   * Backpressure: if bufferedAmount exceeds 1 MB the call waits for the
   * bufferedamountlow event (threshold: 512 KB) before sending.  This prevents
   * the browser's DataChannel send buffer from growing unboundedly when chunks
   * arrive faster than the network can drain them.
   *
   * Edge case — DataChannel closed during wait:
   * If the peer disconnects while we're waiting for bufferedamountlow, the
   * DataChannel transitions to 'closed'.  We re-check readyState after the
   * event resolves and throw rather than silently dropping data.
   */
  async sendRaw(data: ArrayBuffer | string): Promise<void> {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("DataChannel not open");
    }

    const MAX_BUFFER = 1024 * 1024; // 1 MB high-water mark
    if (this.dataChannel.bufferedAmount > MAX_BUFFER) {
      await new Promise<void>((resolve) => {
        if (!this.dataChannel) return resolve();

        const handler = () => {
          if (this.dataChannel) {
            this.dataChannel.removeEventListener("bufferedamountlow", handler);
          }
          resolve();
        };
        this.dataChannel.addEventListener("bufferedamountlow", handler);
      });
    }

    // Re-check after the wait — the channel may have closed while we were paused
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("DataChannel closed during wait");
    }

    this.dataChannel.send(data as ArrayBuffer & string);
  }

  /** Register the handler for incoming DataChannel messages (binary chunks or JSON strings) */
  onData(handler: DataChannelMessageHandler): void {
    this.onDataHandler = handler;
  }

  /** Register the handler for DataChannel state transitions (open, closed) */
  onChannelState(handler: DataChannelStateHandler): void {
    this.onStateHandler = handler;
  }

  /**
   * Close the RTCPeerConnection and DataChannel, nulling out all event handlers.
   *
   * MEM-03: Why null out handlers before closing?
   * If close() is called and a new P2PConnection is created immediately (e.g. on
   * reconnect), the old PC may still fire events (onicecandidate, onconnectionstatechange)
   * after the new instance is set up.  With live handlers still attached, those stale
   * events would be routed to the current session's handlers — corrupting state.
   *
   * Nulling the handlers before calling pc.close() ensures no callbacks fire
   * after this call returns, regardless of when the browser actually tears down
   * the underlying DTLS connection.
   */
  close(): void {
    if (this.dataChannel) {
      // Clear DataChannel handlers before closing
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onerror = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }

    // Clear PeerConnection handlers
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.ondatachannel = null;

    // Clear application-level handler references stored on this instance
    this.onDataHandler = undefined;
    this.onStateHandler = undefined;

    this.pc.close();
  }

  /** Expose the underlying connection state for guard checks in useRemoteTransfer */
  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  /**
   * Bind event handlers to a DataChannel instance.
   *
   * Called once for the sender's createDataChannel() result and once for the
   * receiver's ondatachannel event.  Centralising the binding here avoids
   * duplicating the same four handler assignments in both initiateSender()
   * and initiateReceiver().
   *
   * binaryType = 'arraybuffer': ensures binary messages arrive as ArrayBuffer
   * (the default 'blob' requires an extra async read step).
   *
   * bufferedAmountLowThreshold = 512 KB: the DataChannel fires bufferedamountlow
   * when the send buffer drains below this level — used by sendRaw() to resume
   * sending after a backpressure pause.
   */
  private _bindDataChannelEvents(channel: RTCDataChannel): void {
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 512 * 1024; // 512 KB low-water mark
    channel.onopen = () => this.onStateHandler?.("open");
    channel.onclose = () => this.onStateHandler?.("closed");
    channel.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      this.onDataHandler?.(event.data);
    };
    channel.onerror = (err) => {
      console.error("[WebRTC] DataChannel error:", err);
    };
  }

  /**
   * Log connection and ICE state changes to the console.
   *
   * These transitions help diagnose connectivity issues (STUN failure, firewall
   * blocking, etc.) without requiring the user to open WebRTC internals.
   * Kept separate from _bindDataChannelEvents because these are PeerConnection-level
   * (not DataChannel-level) events and have a different lifecycle.
   */
  private _setupConnectionLogging(): void {
    this.pc.onconnectionstatechange = () => {
      console.log("[WebRTC] Connection state:", this.pc.connectionState);
    };
    this.pc.oniceconnectionstatechange = () => {
      console.log("[WebRTC] ICE state:", this.pc.iceConnectionState);
    };
  }
}
