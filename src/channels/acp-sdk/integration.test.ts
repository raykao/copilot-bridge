import { AgentSideConnection, ClientSideConnection } from '@agentclientprotocol/sdk';
import type { AnyMessage, Client, Stream } from '@agentclientprotocol/sdk';
import type { SessionEvent } from '@github/copilot-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import { CopilotAgent } from './copilot-agent.js';

function makeStreamPair(): [Stream, Stream] {
  const a2b = new TransformStream<AnyMessage, AnyMessage>();
  const b2a = new TransformStream<AnyMessage, AnyMessage>();
  const streamA: Stream = { readable: b2a.readable, writable: a2b.writable };
  const streamB: Stream = { readable: a2b.readable, writable: b2a.writable };
  return [streamA, streamB];
}

describe('ACP SDK integration', () => {
  it('full initialize -> newSession -> prompt round-trip', async () => {
    const mockSession = {
      sessionId: 'int-sess-1',
      on: vi.fn((cb: (e: SessionEvent) => void) => {
        setTimeout(() => cb({ type: 'session.idle' } as SessionEvent), 10);
        return () => {};
      }),
      send: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const mockBridge = {
      getOrCreateBotSession: vi.fn().mockResolvedValue(mockSession),
      setSessionStatus: vi.fn(),
    } as unknown as CopilotBridge;

    const [agentStream, clientStream] = makeStreamPair();

    new AgentSideConnection(
      (conn) => new CopilotAgent(conn, { agent: 'bob' } as AcpBotConfig, mockBridge),
      agentStream,
    );

    const mockClient: Client = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({ outcome: { outcome: 'cancelled' } }),
    };
    const client = new ClientSideConnection((_agent) => mockClient, clientStream);

    const initResult = await client.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(initResult.protocolVersion).toBe(1);

    const sessionResult = await client.newSession({ cwd: '/tmp', mcpServers: [] });
    expect(sessionResult.sessionId).toBe('int-sess-1');

    const promptResult = await client.prompt({
      sessionId: 'int-sess-1',
      prompt: [{ type: 'text', text: 'hello world' }],
    });
    expect(promptResult.stopReason).toBe('end_turn');
    expect(mockSession.send).toHaveBeenCalledWith({ prompt: 'hello world' });
  });
});
