// The return type annotation `: RTCIceServer` on the map callback is required —
// without it TypeScript infers `{ urls: string }[]`, which is too narrow to
// accept the additional `username` and `credential` fields pushed for TURN.
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

export const STUN_SERVERS: RTCConfiguration = {
  iceServers: buildIceServers(),
};

export type DataChannelMessageHandler = (data: ArrayBuffer | string) => void;
export type DataChannelStateHandler = (state: RTCDataChannelState) => void;

export class P2PConnection {
  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;

  // Stored on the instance (not the DataChannel) so callers can register
  // handlers before the DataChannel exists and the handlers survive the
  // receiver's ondatachannel rebind.
  private onDataHandler?: DataChannelMessageHandler;
  private onStateHandler?: DataChannelStateHandler;

  constructor(config: RTCConfiguration = STUN_SERVERS) {
    this.pc = new RTCPeerConnection(config);
    this._setupConnectionLogging();
  }

  async initiateSender(
    onIceCandidate: (candidate: RTCIceCandidateInit) => void,
  ): Promise<RTCSessionDescriptionInit> {
    this.dataChannel = this.pc.createDataChannel("file-transfer", {
      // ordered:true so chunks arrive in order — avoids a reordering buffer
      ordered: true,
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

  async initiateReceiver(
    offer: RTCSessionDescriptionInit,
    onIceCandidate: (candidate: RTCIceCandidateInit) => void,
  ): Promise<RTCSessionDescriptionInit> {
    // Sender creates the DataChannel; receiver gets it via ondatachannel
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

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(new RTCSessionDescription(desc));
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
  }

  /**
   * Backpressure: if bufferedAmount exceeds 1 MB, wait for bufferedamountlow
   * (threshold 512 KB) before sending. Re-checks readyState after the wait
   * because the peer may have disconnected while paused — throw rather than
   * silently dropping data.
   */
  async sendRaw(data: ArrayBuffer | string): Promise<void> {
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("DataChannel not open");
    }

    const MAX_BUFFER = 1024 * 1024;
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

    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("DataChannel closed during wait");
    }

    this.dataChannel.send(data as ArrayBuffer & string);
  }

  onData(handler: DataChannelMessageHandler): void {
    this.onDataHandler = handler;
  }

  onChannelState(handler: DataChannelStateHandler): void {
    this.onStateHandler = handler;
  }

  /**
   * Null out handlers before calling pc.close(): the old PC can still fire
   * onicecandidate/onconnectionstatechange after close, and if a new
   * P2PConnection is created immediately those stale events would otherwise
   * route to the new session's handlers and corrupt state.
   */
  close(): void {
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onerror = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }

    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.ondatachannel = null;

    this.onDataHandler = undefined;
    this.onStateHandler = undefined;

    this.pc.close();
  }

  get connectionState(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  private _bindDataChannelEvents(channel: RTCDataChannel): void {
    // arraybuffer avoids the async read step required by the default 'blob' type
    channel.binaryType = "arraybuffer";
    // bufferedamountlow fires when the send buffer drains below this — used
    // by sendRaw() to resume after a backpressure pause.
    channel.bufferedAmountLowThreshold = 512 * 1024;
    channel.onopen = () => this.onStateHandler?.("open");
    channel.onclose = () => this.onStateHandler?.("closed");
    channel.onmessage = (event: MessageEvent<ArrayBuffer | string>) => {
      this.onDataHandler?.(event.data);
    };
    channel.onerror = (err) => {
      console.error("[WebRTC] DataChannel error:", err);
    };
  }

  private _setupConnectionLogging(): void {
    this.pc.onconnectionstatechange = () => {
      console.log("[WebRTC] Connection state:", this.pc.connectionState);
    };
    this.pc.oniceconnectionstatechange = () => {
      console.log("[WebRTC] ICE state:", this.pc.iceConnectionState);
    };
  }
}
