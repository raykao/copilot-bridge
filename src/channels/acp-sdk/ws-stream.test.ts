import { WebSocket } from 'ws';
import type { AnyMessage } from '@agentclientprotocol/sdk';
import { describe, it, expect, vi } from 'vitest';
import { wsStream } from './ws-stream.js';

type MockWebSocket = {
  readyState: typeof WebSocket.OPEN;
  on: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

type MessageHandler = (data: Buffer) => void;
type CloseHandler = () => void;

function createMockWebSocket(): MockWebSocket {
  return {
    readyState: WebSocket.OPEN,
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  };
}

function findHandler<T extends (...args: never[]) => void>(mockWs: MockWebSocket, eventName: string): T {
  const call = mockWs.on.mock.calls.find(([name]) => name === eventName);
  expect(call).toBeDefined();
  const handler = call?.[1];
  expect(handler).toBeTypeOf('function');
  return handler as T;
}

describe('wsStream', () => {
  it('wsStream readable delivers parsed messages', async () => {
    const mockWs = createMockWebSocket();
    const { readable } = wsStream(mockWs as unknown as WebSocket);
    const handler = findHandler<MessageHandler>(mockWs, 'message');
    const message = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

    handler(Buffer.from(JSON.stringify(message)));
    const result = await readable.getReader().read();

    expect(result.value).toEqual(message);
  });

  it('wsStream writable serialises and sends', async () => {
    const mockWs = createMockWebSocket();
    const { writable } = wsStream(mockWs as unknown as WebSocket);
    const writer = writable.getWriter();
    const message = { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } } as AnyMessage;

    await writer.write(message);

    expect(mockWs.send).toHaveBeenCalledWith(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } }),
    );
  });

  it('wsStream readable closes when WS closes', async () => {
    const mockWs = createMockWebSocket();
    const { readable } = wsStream(mockWs as unknown as WebSocket);
    const handler = findHandler<CloseHandler>(mockWs, 'close');

    handler();
    const result = await readable.getReader().read();

    expect(result.done).toBe(true);
  });
});
