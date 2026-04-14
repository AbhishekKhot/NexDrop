import '@testing-library/react';
import { vi } from 'vitest';

// Mock WebRTC
class MockRTCPeerConnection {
  createDataChannel = vi.fn().mockReturnValue({
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    readyState: 'open',
  });
  createOffer = vi.fn().mockResolvedValue({ type: 'offer', sdp: 'mock-sdp' });
  createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'mock-sdp' });
  setLocalDescription = vi.fn().mockResolvedValue(undefined);
  setRemoteDescription = vi.fn().mockResolvedValue(undefined);
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  connectionState = 'connected';
}

global.RTCPeerConnection = MockRTCPeerConnection as any;
global.RTCSessionDescription = vi.fn() as any;
global.RTCIceCandidate = vi.fn() as any;

// Mock WebSocket
class MockWebSocket {
  send = vi.fn();
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  readyState = WebSocket.OPEN;
  
  static OPEN = 1;
  static CLOSED = 3;
}

global.WebSocket = MockWebSocket as any;

// Mock URL
global.URL.createObjectURL = vi.fn().mockReturnValue('mock-url');
global.URL.revokeObjectURL = vi.fn();
