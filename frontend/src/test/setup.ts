import '@testing-library/react';
import { vi } from 'vitest';

class MockWebSocket {
  send = vi.fn();
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
  readyState = WebSocket.OPEN;

  static OPEN = 1;
  static CLOSED = 3;
}

global.WebSocket = MockWebSocket as never;

global.URL.createObjectURL = vi.fn().mockReturnValue('mock-url');
global.URL.revokeObjectURL = vi.fn();
