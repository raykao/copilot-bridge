import { AgentSideConnection, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type * as schema from '@agentclientprotocol/sdk';
import type { CopilotSession, SessionEvent } from '@github/copilot-sdk';
import { describe, expect, it, vi } from 'vitest';
import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import { CopilotAgent, translateToSessionUpdate } from './copilot-agent.js';
import { SdkEventTranslator } from './sdk-event-translator.js';

function createAgent(
  bridge: Partial<CopilotBridge> = {},
  connection: Partial<AgentSideConnection> = {},
): CopilotAgent {
  const botCfg: AcpBotConfig = {};
  return new CopilotAgent(
    connection as AgentSideConnection,
    botCfg,
    bridge as CopilotBridge,
  );
}

function createFakeEntry(session: Partial<CopilotSession>) {
  return {
    session: session as CopilotSession,
    unsubscribe: vi.fn(),
    translator: new SdkEventTranslator(),
    abortController: new AbortController(),
  };
}

describe('CopilotAgent', () => {
  it('initialize returns PROTOCOL_VERSION and resume capability', async () => {
    const agent = createAgent();

    const result = await agent.initialize({} as schema.InitializeRequest);

    expect(result).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        sessionCapabilities: {
          resume: {},
          close: {},
        },
      },
    });
  });

  it('authenticate returns empty object', async () => {
    const agent = createAgent();

    const result = await agent.authenticate({} as schema.AuthenticateRequest);

    expect(result).toEqual({});
  });

  it('newSession creates bridge session and returns sessionId', async () => {
    const fakeSession = {
      sessionId: 'sess-123',
      on: vi.fn(() => () => {}),
      send: vi.fn(),
      disconnect: vi.fn(),
      abort: vi.fn(),
    };
    const bridge = {
      createSession: vi.fn().mockResolvedValue(fakeSession),
    };
    const connection = {
      sessionUpdate: vi.fn(),
    };
    const agent = createAgent(bridge as Partial<CopilotBridge>, connection);

    const result = await agent.newSession({ cwd: '/tmp', mcpServers: [] });

    expect(result).toEqual({ sessionId: 'sess-123' });
    expect(bridge.createSession).toHaveBeenCalledOnce();
  });

  it('prompt sends text and returns end_turn on idle', async () => {
    let listener: ((event: SessionEvent) => void) | undefined;
    const session = {
      on: vi.fn((handler: (event: SessionEvent) => void) => {
        listener = handler;
        return vi.fn();
      }),
      send: vi.fn().mockResolvedValue('msg-123'),
    };
    const agent = createAgent();
    agent['sessions'].set('sess-123', createFakeEntry(session));

    const promptPromise = agent.prompt({
      sessionId: 'sess-123',
      prompt: [{ type: 'text', text: 'hello' }],
    });
    setImmediate(() => {
      listener?.({ type: 'session.idle' } as SessionEvent);
    });

    const result = await promptPromise;

    expect(result).toEqual({ stopReason: 'end_turn' });
    expect(session.send).toHaveBeenCalledWith({ prompt: 'hello' });
  });

  it('cancel aborts the session', async () => {
    const session = {
      abort: vi.fn().mockResolvedValue(undefined),
    };
    const agent = createAgent();
    agent['sessions'].set('sess-123', createFakeEntry(session));

    await agent.cancel({ sessionId: 'sess-123' });

    expect(session.abort).toHaveBeenCalled();
  });

  it('translateToSessionUpdate streaming -> agent_message_chunk', () => {
    const result = translateToSessionUpdate({ type: 'streaming', content: 'hello' }, 'sess-123');

    expect(result).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello' },
    });
  });
});
