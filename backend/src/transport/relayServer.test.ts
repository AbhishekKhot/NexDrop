import { WebSocket } from "ws";
import { RelayServer } from "./relayServer";
import { RELAY_PROTOCOL_VERSION, RELAY_MAX_FILE_SIZE } from "../config";

const ALLOWED_ORIGIN = "http://localhost:5173";

// Minimal client that buffers text messages (as parsed JSON) and binary frames
// separately so tests can await the next control message deterministically.
class TestClient {
  ws: WebSocket;
  binary: Buffer[] = [];
  private queue: Record<string, unknown>[] = [];
  private waiters: ((m: Record<string, unknown>) => void)[] = [];
  closeCode: number | null = null;

  constructor(url: string, origin: string = ALLOWED_ORIGIN) {
    this.ws = new WebSocket(url, { headers: { origin } });
    this.ws.binaryType = "nodebuffer";
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.binary.push(data as Buffer);
        return;
      }
      const msg = JSON.parse((data as Buffer).toString("utf8"));
      const w = this.waiters.shift();
      if (w) w(msg);
      else this.queue.push(msg);
    });
    this.ws.on("close", (code) => {
      this.closeCode = code;
    });
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws.once("open", () => resolve());
      this.ws.once("error", reject);
    });
  }

  next(): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  send(obj: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(obj));
  }

  sendBinary(buf: Buffer): void {
    this.ws.send(buf);
  }

  close(): void {
    this.ws.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("RelayServer", () => {
  let server: RelayServer;
  let url: string;

  beforeEach(async () => {
    // Ephemeral port + fresh state per test (resets rate-limit / room maps).
    server = new RelayServer(0, "127.0.0.1");
    await delay(20);
    url = `ws://127.0.0.1:${server.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  async function connectHello(): Promise<TestClient> {
    const c = new TestClient(url);
    await c.open();
    c.send({ t: "hello", v: RELAY_PROTOCOL_VERSION });
    const welcome = await c.next();
    expect(welcome.t).toBe("welcome");
    return c;
  }

  // Host creates a room and joiner joins; returns both paired clients.
  async function pair(): Promise<{ host: TestClient; joiner: TestClient; code: string }> {
    const host = await connectHello();
    host.send({ t: "create", maxFileSize: RELAY_MAX_FILE_SIZE });
    const created = await host.next();
    expect(created.t).toBe("created");
    const code = created.code as string;

    const joiner = await connectHello();
    joiner.send({ t: "join", code, maxFileSize: 2 * 1024 * 1024 * 1024 });

    const joined = await joiner.next();
    expect(joined.t).toBe("joined");
    const peerJoined = await host.next();
    expect(peerJoined.t).toBe("peer_joined");

    return { host, joiner, code };
  }

  it("completes hello/welcome handshake", async () => {
    const c = await connectHello();
    c.close();
  });

  it("rejects an unsupported protocol version", async () => {
    const c = new TestClient(url);
    await c.open();
    c.send({ t: "hello", v: 999 });
    const err = await c.next();
    expect(err).toMatchObject({ t: "error", code: "UNSUPPORTED_VERSION" });
  });

  it("rejects non-hello as the first frame", async () => {
    const c = new TestClient(url);
    await c.open();
    c.send({ t: "create" });
    const err = await c.next();
    expect(err).toMatchObject({ t: "error", code: "PROTOCOL_VIOLATION" });
  });

  it("creates a room with a 10-char Crockford code", async () => {
    const c = await connectHello();
    c.send({ t: "create" });
    const created = await c.next();
    expect(created.t).toBe("created");
    expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    c.close();
  });

  it("rejects a second create from the same connection", async () => {
    const c = await connectHello();
    c.send({ t: "create" });
    await c.next();
    c.send({ t: "create" });
    const err = await c.next();
    expect(err).toMatchObject({ t: "error", code: "ALREADY_IN_ROOM" });
    c.close();
  });

  it("pairs host and joiner and exchanges capabilities", async () => {
    const host = await connectHello();
    host.send({ t: "create", maxFileSize: RELAY_MAX_FILE_SIZE });
    const created = await host.next();
    const code = created.code as string;

    const joiner = await connectHello();
    joiner.send({ t: "join", code, maxFileSize: 2 * 1024 * 1024 * 1024 });

    const joined = await joiner.next();
    expect(joined).toMatchObject({ t: "joined", code, peerMaxFileSize: RELAY_MAX_FILE_SIZE });
    const peerJoined = await host.next();
    expect(peerJoined).toMatchObject({ t: "peer_joined", peerMaxFileSize: 2 * 1024 * 1024 * 1024 });

    host.close();
    joiner.close();
  });

  it("returns ROOM_NOT_FOUND for an unknown code", async () => {
    const c = await connectHello();
    c.send({ t: "join", code: "ABCDEFGHJK" });
    const err = await c.next();
    expect(err).toMatchObject({ t: "error", code: "ROOM_NOT_FOUND" });
    c.close();
  });

  it("returns ROOM_NOT_FOUND for a malformed code", async () => {
    const c = await connectHello();
    c.send({ t: "join", code: "bad!" });
    const err = await c.next();
    expect(err).toMatchObject({ t: "error", code: "ROOM_NOT_FOUND" });
    c.close();
  });

  it("rejects a third peer with ROOM_FULL", async () => {
    const { code, host, joiner } = await pair();
    const third = await connectHello();
    third.send({ t: "join", code });
    const err = await third.next();
    expect(err).toMatchObject({ t: "error", code: "ROOM_FULL" });
    host.close();
    joiner.close();
    third.close();
  });

  it("forwards peer-relayed control messages verbatim", async () => {
    const { host, joiner } = await pair();
    host.send({ t: "ecdh_hello", publicKey: "BASE64KEY==" });
    const got = await joiner.next();
    expect(got).toMatchObject({ t: "ecdh_hello", publicKey: "BASE64KEY==" });
    host.close();
    joiner.close();
  });

  it("rejects oversize transfer_begin with FILE_TOO_LARGE", async () => {
    const { host, joiner } = await pair();
    host.send({
      t: "transfer_begin",
      transferId: "t1",
      fileSize: RELAY_MAX_FILE_SIZE + 1,
      totalChunks: 1,
    });
    const err = await host.next();
    expect(err).toMatchObject({ t: "error", code: "FILE_TOO_LARGE" });
    host.close();
    joiner.close();
  });

  it("streams binary data end-to-end and closes the transfer", async () => {
    const { host, joiner } = await pair();
    const payload = Buffer.from("encrypted-chunk-bytes-🔒".repeat(100));

    host.send({ t: "transfer_begin", transferId: "t1", fileSize: payload.length, totalChunks: 1 });
    const begin = await joiner.next();
    expect(begin).toMatchObject({ t: "transfer_begin", transferId: "t1" });

    host.sendBinary(payload);
    host.send({ t: "transfer_end", transferId: "t1" });

    const end = await joiner.next();
    expect(end).toMatchObject({ t: "transfer_end", transferId: "t1" });

    // Binary arrives before transfer_end (TCP ordering).
    expect(joiner.binary).toHaveLength(1);
    expect(Buffer.concat(joiner.binary).equals(payload)).toBe(true);

    host.close();
    joiner.close();
  });

  it("rejects a binary frame with no active transfer", async () => {
    const { host, joiner } = await pair();
    host.sendBinary(Buffer.from("nope"));
    const err = await host.next();
    expect(err).toMatchObject({ t: "error", code: "PROTOCOL_VIOLATION" });
    host.close();
    joiner.close();
  });

  it("hard-aborts a sender streaming more than the declared size", async () => {
    const { host, joiner } = await pair();
    host.send({ t: "transfer_begin", transferId: "t1", fileSize: 16, totalChunks: 1 });
    await joiner.next(); // transfer_begin
    // Far exceeds 16 bytes + per-chunk overhead + slack.
    host.sendBinary(Buffer.alloc(8192));
    const err = await host.next();
    expect(err).toMatchObject({ t: "error", code: "FILE_TOO_LARGE" });
    host.close();
    joiner.close();
  });

  it("rejects transfer_begin while a transfer is already active", async () => {
    const { host, joiner } = await pair();
    host.send({ t: "transfer_begin", transferId: "t1", fileSize: 100, totalChunks: 1 });
    await joiner.next();
    host.send({ t: "transfer_begin", transferId: "t2", fileSize: 100, totalChunks: 1 });
    const err = await host.next();
    expect(err).toMatchObject({ t: "error", code: "TRANSFER_ACTIVE" });
    host.close();
    joiner.close();
  });

  it("notifies the survivor with peer_left when a peer disconnects", async () => {
    const { host, joiner } = await pair();
    joiner.close();
    const left = await host.next();
    expect(left).toMatchObject({ t: "peer_left" });
    host.close();
  });

  it("enforces the per-IP connection cap", async () => {
    // Default cap is 5; the 6th connection from the same IP is rejected.
    const clients: TestClient[] = [];
    for (let i = 0; i < 5; i++) {
      const c = new TestClient(url);
      await c.open();
      clients.push(c);
    }
    const sixth = new TestClient(url);
    await sixth.open();
    const err = await sixth.next();
    expect(err).toMatchObject({ t: "error", code: "RATE_LIMITED" });

    for (const c of clients) c.close();
    sixth.close();
  });
});

describe("RelayServer (limit overrides)", () => {
  let server: RelayServer;
  let url: string;

  afterEach(async () => {
    if (server) await server.close();
  });

  async function start(
    limits: Partial<import("./relayServer").RelayLimits>,
  ): Promise<void> {
    server = new RelayServer(0, "127.0.0.1", limits);
    await delay(20);
    url = `ws://127.0.0.1:${server.port}`;
  }

  it("expires a WAITING room after the idle TTL", async () => {
    await start({ roomTtlMs: 60 });

    const host = new TestClient(url);
    await host.open();
    host.send({ t: "hello", v: RELAY_PROTOCOL_VERSION });
    expect((await host.next()).t).toBe("welcome");
    host.send({ t: "create" });
    const created = await host.next();
    const code = created.code as string;

    // Idle TTL fires → the lone host is notified the room is gone.
    const expired = await host.next();
    expect(expired).toMatchObject({ t: "peer_left" });

    // The code is no longer joinable.
    const joiner = new TestClient(url);
    await joiner.open();
    joiner.send({ t: "hello", v: RELAY_PROTOCOL_VERSION });
    await joiner.next();
    joiner.send({ t: "join", code });
    expect(await joiner.next()).toMatchObject({ t: "error", code: "ROOM_NOT_FOUND" });

    host.close();
    joiner.close();
  });

  it("rate-limits control frames per connection", async () => {
    await start({ maxMsgPerSec: 1 });

    const c = new TestClient(url);
    await c.open();
    // hello consumes the only token; the next control frame is rejected.
    c.send({ t: "hello", v: RELAY_PROTOCOL_VERSION });
    c.send({ t: "leave" });

    expect((await c.next()).t).toBe("welcome");
    expect(await c.next()).toMatchObject({ t: "error", code: "RATE_LIMITED" });
    c.close();
  });

  it("rate-limits repeated failed joins per IP", async () => {
    await start({ maxFailedJoins: 2 });

    const c = new TestClient(url);
    await c.open();
    c.send({ t: "hello", v: RELAY_PROTOCOL_VERSION });
    expect((await c.next()).t).toBe("welcome");

    // Two genuine not-founds, then the IP is rate-limited.
    c.send({ t: "join", code: "AAAAAAAAAA" });
    expect(await c.next()).toMatchObject({ t: "error", code: "ROOM_NOT_FOUND" });
    c.send({ t: "join", code: "BBBBBBBBBB" });
    expect(await c.next()).toMatchObject({ t: "error", code: "ROOM_NOT_FOUND" });
    c.send({ t: "join", code: "CCCCCCCCCC" });
    expect(await c.next()).toMatchObject({ t: "error", code: "RATE_LIMITED" });
    c.close();
  });
});
