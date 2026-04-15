/**
 * webrtc.ts
 * WebRTC DataChannel wrapper for remote P2P file transfer.
 *
 * Fixes applied:
 *  MEM-03 — Null out all event handlers in close() to prevent stale callbacks
 *            and listener accumulation across reconnect cycles
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
  private onDataHandler?: DataChannelMessageHandler;
  private onStateHandler?: DataChannelStateHandler;

  constructor(config: RTCConfiguration = STUN_SERVERS) {
    this.pc = new RTCPeerConnection(config);
    this._setupConnectionLogging();
  }

  /** Called on sender side — creates the DataChannel and offer */
  async initiateSender(
    onIceCandidate: (candidate: RTCIceCandidateInit) => void,
  ): Promise<RTCSessionDescriptionInit> {
    this.dataChannel = this.pc.createDataChannel("file-transfer", {
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

  /** Called on receiver side — accepts the offer, creates answer */
  async initiateReceiver(
    offer: RTCSessionDescriptionInit,
    onIceCandidate: (candidate: RTCIceCandidateInit) => void,
  ): Promise<RTCSessionDescriptionInit> {
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

  /** MEM-03: null out all event handlers to prevent stale callbacks */
  close(): void {
    // Null out DataChannel handlers
    if (this.dataChannel) {
      this.dataChannel.onopen = null;
      this.dataChannel.onclose = null;
      this.dataChannel.onmessage = null;
      this.dataChannel.onerror = null;
      this.dataChannel.close();
      this.dataChannel = null;
    }

    // Null out PeerConnection handlers
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
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = 512 * 1024; // 512 KB
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
