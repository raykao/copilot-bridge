import { describe, expect, it, vi } from 'vitest';
import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import type { CopilotSession, PermissionRequestResult, SessionEvent } from '@github/copilot-sdk';
import type { JsonRpcResponse } from './types.js';
import { AcpConnectionHandler } from './connection-handler.js';

type SentMessage = Record<string, unknown>;
type SessionHandler = (event: SessionEvent) => void;

interface FakeSession {
  sessionId: string;
  send: ReturnType<typeof vi.fn<(input: { prompt: string }) => Promise<string>>>;
  on: ReturnType<typeof vi.fn<(handler: SessionHandler) => () => void>>;
  abort: ReturnType<typeof vi.fn<() => Promise<void>>>;
  disconnect: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

interface CreateSessionOptions {
  workingDirectory?: string;
  model?: string;
  agent?: string;
  onPermissionRequest: (
    request: { kind: 'shell'; toolCallId?: string },
    invocation: { sessionId: string },
  ) => PermissionRequestResult | Promise<PermissionRequestResult>;
}

function botConfig(): AcpBotConfig {
  return {
    agent: 'bob',
    model: 'claude-sonnet-4.6',
    workingDirectory: '/test/workspace',
  };
}

function fakeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    sessionId: 's1',
    send: vi.fn(async () => 'm1'),
    on: vi.fn(() => vi.fn()),
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
}

function bridgeWithSession(session: FakeSession): {
  bridge: CopilotBridge;
  createSession: ReturnType<typeof vi.fn<(opts: CreateSessionOptions) => Promise<CopilotSession>>>;
} {
  const createSession = vi.fn(async (_opts: CreateSessionOptions) => session as unknown as CopilotSession);
  return {
    bridge: { createSession } as unknown as CopilotBridge,
    createSession,
  };
}

describe('AcpConnectionHandler', () => {
  it('malformed JSON sends parse error code -32700', async () => {
    const sent: SentMessage[] = [];
    const { bridge } = bridgeWithSession(fakeSession());
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));

    await handler.handle('{bad json');

    expect(sent).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    ]);
  });

  it('unknown method sends method not found code -32601', async () => {
    const sent: SentMessage[] = [];
    const { bridge } = bridgeWithSession(fakeSession());
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));

    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'nope' }));

    expect(sent).toEqual([
      { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } },
    ]);
  });

  it('initialize echoes protocolVersion with agentCapabilities {}, authMethods []', async () => {
    const sent: SentMessage[] = [];
    const { bridge } = bridgeWithSession(fakeSession());
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));

    await handler.handle(JSON.stringify({
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '1', clientCapabilities: {} },
    }));

    expect(sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 'init',
        result: { protocolVersion: '1', agentCapabilities: {}, authMethods: [] },
      },
    ]);
  });

  it("session/new creates session and returns sessionId, createSession called with workingDirectory '/test/workspace'", async () => {
    const sent: SentMessage[] = [];
    const session = fakeSession();
    const { bridge, createSession } = bridgeWithSession(session);
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));

    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} }));

    expect(createSession).toHaveBeenCalledOnce();
    expect(createSession.mock.calls[0]?.[0].workingDirectory).toBe('/test/workspace');
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 2, result: { sessionId: 's1' } });
  });

  it('session/prompt waits for idle and returns stopReason idle', async () => {
    const sent: SentMessage[] = [];
    let subscriptionCount = 0;
    const session = fakeSession({
      on: vi.fn((handler: SessionHandler) => {
        subscriptionCount += 1;
        if (subscriptionCount === 2) {
          handler({ type: 'session.idle' } as SessionEvent);
        }
        return vi.fn();
      }),
    });
    const { bridge } = bridgeWithSession(session);
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }));

    await handler.handle(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/prompt',
      params: { sessionId: 's1', prompt: 'hello' },
    }));

    expect(session.send).toHaveBeenCalledWith({ prompt: 'hello' });
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 2, result: { stopReason: 'idle' } });
  });

  it('permission request parks and resolves on response', async () => {
    const sent: SentMessage[] = [];
    let permissionPromise: Promise<PermissionRequestResult> | undefined;
    const session = fakeSession();
    const createSession = vi.fn(async (opts: CreateSessionOptions) => {
      permissionPromise = Promise.resolve(opts.onPermissionRequest({ kind: 'shell' }, { sessionId: 's1' }));
      return session as unknown as CopilotSession;
    });
    const bridge = { createSession } as unknown as CopilotBridge;
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));

    const sessionNewPromise = handler.handle(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/new',
      params: {},
    }));

    await vi.waitFor(() => {
      expect(sent.some((msg) => msg.method === 'session/request_permission')).toBe(true);
    });
    const request = sent.find((msg) => msg.method === 'session/request_permission');
    expect(request).toBeDefined();
    expect((request?.params as { kind: string }).kind).toBe('shell');

    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: request?.id as string,
      result: { decision: 'allow' },
    };
    await handler.handle(JSON.stringify(response));

    await expect(permissionPromise).resolves.toEqual({ kind: 'approved' });
    await sessionNewPromise;
  });

  it('closeAll aborts and disconnects all sessions', async () => {
    const sent: SentMessage[] = [];
    const session = fakeSession();
    const { bridge } = bridgeWithSession(session);
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }));

    await handler.closeAll();

    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.disconnect).toHaveBeenCalledOnce();
  });
});
