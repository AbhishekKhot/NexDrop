/**
 * webrtc.ts
 * WebRTC DataChannel wrapper for remote P2P file transfer.
 *
 * Flow:
 *  Sender:   createOffer() → get localDescription → send via signaling →
 *            receive remoteDescription + ICE → DataChannel opens → stream chunks
 *  Receiver: receive offer → createAnswer() → send via signaling →
 *            receive ICE → DataChannel opens → receive chunks
 *
 * Note: The signaling server only relays SDP and ICE candidates.
 *       File bytes NEVER touch the signaling server.
 */

function buildIceServers(): RTCIceServer[] {
  const stunList = (
    import.meta.env.VITE_STUN_SERVERS ||
    "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302"
  )
    .split(",")
    .map((url: string) => ({ urls: url.trim() }));

  const turnUrl = import.meta.env.VITE_TURN_SERVER_URL as string | undefined;
  if (turnUrl) {
    stunList.push({
      urls: turnUrl,
      username: import.meta.env.VITE_TURN_USERNAME as string | undefined,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string | undefined,
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
    this._setupIceCandidateLogging();
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

    // Wait if the buffer is full (MAX threshold e.g., 1MB)
    const MAX_BUFFER = 1024 * 1024;
    if (this.dataChannel.bufferedAmount > MAX_BUFFER) {
      await new Promise<void>((resolve) => {
        if (!this.dataChannel) return resolve();
        
        const handler = () => {
          if (this.dataChannel) {
            this.dataChannel.removeEventListener('bufferedamountlow', handler);
          }
          resolve();
        };
        this.dataChannel.addEventListener('bufferedamountlow', handler);
      });
    }

    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("DataChannel closed during wait");
    }

    if (typeof data === "string") {
      this.dataChannel.send(data);
    } else {
      this.dataChannel.send(data);
    }
  }

  onData(handler: DataChannelMessageHandler): void {
    this.onDataHandler = handler;
  }

  onChannelState(handler: DataChannelStateHandler): void {
    this.onStateHandler = handler;
  }

  close(): void {
    this.dataChannel?.close();
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
  }

  private _setupIceCandidateLogging(): void {
    this.pc.onconnectionstatechange = () => {
      console.log("[WebRTC] Connection state:", this.pc.connectionState);
    };
    this.pc.oniceconnectionstatechange = () => {
      console.log("[WebRTC] ICE state:", this.pc.iceConnectionState);
    };
  }
}
