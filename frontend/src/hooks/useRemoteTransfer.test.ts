import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useRemoteTransfer } from './useRemoteTransfer';

describe('useRemoteTransfer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should initialize with null state', () => {
    const { result } = renderHook(() => useRemoteTransfer());
    expect(result.current.shareCode).toBeNull();
    expect(result.current.remotePeer).toBeNull();
    expect(result.current.transfers.size).toBe(0);
  });

  it('should create a room and set initiator', () => {
    const { result } = renderHook(() => useRemoteTransfer());
    
    act(() => {
      result.current.createRoom();
    });

    expect(typeof result.current.createRoom).toBe('function');
  });

  it('should add a transfer to state when sending a file', async () => {
    const { result } = renderHook(() => useRemoteTransfer());

    act(() => {
      result.current.joinRoom('TEST_CODE');
    });

    const mockFile = new File(['hello world'], 'hello.txt', { type: 'text/plain' });

    await act(async () => {
      await result.current.sendRemoteFile(mockFile);
    });

    expect(result.current.transfers.size).toBe(1);
    const transfer = Array.from(result.current.transfers.values())[0];
    expect(transfer.fileName).toBe('hello.txt');
    expect(transfer.direction).toBe('send');
  });
});
