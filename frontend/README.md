# PeerDrop

Secure, peer-to-peer file transfer utility for LAN and Remote networks. End-to-end encrypted with no file bytes ever stored on a central server.

## Features & Technical Overview

- **Zero Server Storage**: Files pass directly from browser to browser (Remote) or browser to local-agent to local-agent (LAN).
- **Chunking Strategy**: Files are sliced via HTML5 File API into `256 KB` binary chunks. Chunks are sent sequentially over the wire via `ArrayBuffer` to prevent memory bloat on large files.
- **Integrity**: Every chunk and the finalized file are validated via SHA-256 hash checks.
- **Encryption**: ECDH key exchange establishes a shared secret per session, with AES-256-GCM encrypting each chunk prior to transport.

## Setup & Usage

### 1. Frontend Setup (React/Vite)

```bash
# Install dependencies
npm install

# Start development server
npm run dev
```

Access the application at `http://localhost:5173`.

### 2. Backend Setup (LAN Agent & Signaling)

_Required for LAN transfers & Remote discovery._

```bash
cd backend
npm install
npm run dev
```

The agent listens on `ws://localhost:4001` by default and utilizes `mDNS` to broadcast its presence on the local network.

---

## System Level Design (SLD)

### 1. LAN Transfer Mode

In **LAN Mode**, the React application delegates networking and cryptography processing to a local Node.js daemon (the "Agent"). The Agent handles mDNS peer discovery, file encryption, and establishing a high-throughput raw TCP connection over the local network.

```mermaid
sequenceDiagram
    autonumber
    participant SB as Sender Browser (React)
    participant SA as Sender Agent (Node ws://4001)
    participant RA as Receiver Agent (Node)
    participant RB as Receiver Browser (React)

    Note over SA, RA: Background: Continuous mDNS Discovery
    SA-->>SB: WebSocket: JSON {peers_update}

    %% File Send Initiation
    SB->>SA: WebSocket JSON: send_file_start (meta, totalChunks)
    SA->>RA: TCP Syn: Initiate Transfer & ECDH Key Exchange

    %% Chunk Streaming
    loop For each 256 KB slice of the File
        SB->>SB: HTML5 File API: slice(start, end).arrayBuffer()
        SB->>SA: WebSocket Binary: [4-byte Index] + 256KB ArrayBuffer (Raw)
        SA->>SA: Encrypt ArrayBuffer with AES-256-GCM
        SA->>RA: TCP Binary Stream: Encrypted Chunk
        RA->>RA: Decrypt & check SHA-256 hash
        RA-->>RB: WebSocket JSON: transfer_update (progress %)
    end

    %% Completion
    SB->>SA: WebSocket JSON: send_file_end
    SA->>RA: TCP: End of Stream Marker
    RA-->>RB: WebSocket JSON: transfer_update (state: completed)
```

### 2. Remote Transfer Mode

In **Remote Mode**, the frontend applications connect directly, browser-to-browser, using WebRTC `RTCDataChannel`. The signaling server only maps connection codes and routes `SDP` and `ICE` payloads to establish the connection geometry. **It never touches the file bytes**.

```mermaid
sequenceDiagram
    autonumber
    participant S as Sender Browser (React)
    participant Sig as Signaling Server (Node)
    participant STUN as Google STUN Servers
    participant R as Receiver Browser (React)

    %% Signaling
    S->>Sig: WebSocket: Register / Generate Share Code
    R->>Sig: WebSocket: Join via Share Code
    S->>STUN: Request ICE Candidates (public IP/port)
    R->>STUN: Request ICE Candidates
    S->>Sig: Route SDP Offers & ICE candidates
    Sig->>R: Deliver SDP Offers & ICE candidates

    %% WebRTC Connection
    Note over S, R: NAT Traversal Successful
    S->>R: Establish WebRTC RTCDataChannel ("file-transfer")

    %% Chunk Streaming
    S->>R: DataChannel JSON: send_file_start
    loop For each 256 KB slice of the File
        S->>S: HTML5 File API: slice(start, end).arrayBuffer()
        S->>R: WebRTC DataChannel Binary: 256KB ArrayBuffer
        R->>R: Reconstruct File Blob, Verify SHA-256, Update Progress
    end

    %% Completion
    S->>R: DataChannel JSON: send_file_end
    R->>R: Validate total hash & Trigger File Download Prompt
```
