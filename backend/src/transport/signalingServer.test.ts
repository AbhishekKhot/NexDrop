import { WebSocket } from 'ws';
import { createSignalingServer } from './signalingServer';

describe('Signaling Server', () => {
  let server: ReturnType<typeof createSignalingServer>;
  const port = 4002;

  beforeAll((done) => {
    server = createSignalingServer();
    // Wait for listening
    server.on('listening', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  it('should create a room and return a roomId on "create" message', (done) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'create' }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      expect(msg.type).toBe('joined');
      expect(typeof msg.roomId).toBe('string');
      expect(msg.roomId.length).toBeGreaterThan(0);
      ws.close();
      setTimeout(done, 100);
    });
  });

  it('should relay messages between two peers in the same room', (done) => {
    const ws1 = new WebSocket(`ws://localhost:${port}`);
    let roomId: string;
    let ws2: WebSocket;

    ws1.on('open', () => {
      ws1.send(JSON.stringify({ type: 'create' }));
    });

    ws1.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      
      if (msg.type === 'joined' && !roomId) {
        roomId = msg.roomId;
        // Connect second peer
        ws2 = new WebSocket(`ws://localhost:${port}`);
        
        ws2.on('open', () => {
          ws2.send(JSON.stringify({ type: 'join', roomId }));
        });

        ws2.on('message', (data2) => {
          const msg2 = JSON.parse(data2.toString());
          if (msg2.type === 'joined') {
            // Second peer joined successfully, now let's send an offer
            ws1.send(JSON.stringify({ type: 'offer', sdp: { type: 'offer', sdp: 'xyz' } }));
          } else if (msg2.type === 'offer') {
            expect(msg2.sdp.sdp).toBe('xyz');
            ws1.close();
            ws2.close();
            setTimeout(done, 100);
          }
        });
      } else if (msg.type === 'peer_joined') {
        // First peer received notification 
        expect(true).toBe(true);
      }
    });
  });
});
