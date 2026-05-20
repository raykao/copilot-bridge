import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import type { CopilotSession, PermissionHandler, PermissionRequestResult, SessionEvent } from '@github/copilot-sdk';
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
  registerPermissionHandler: ReturnType<typeof vi.fn<(handler: PermissionHandler) => void>>;
}

interface BotSessionOptions {
  model?: string;
  onPermissionRequest: (
    request: { kind: 'shell'; toolCallId?: string; fullCommandText?: string; intention?: string },
    invocation: { sessionId: string },
  ) => PermissionRequestResult | Promise<PermissionRequestResult>;
}

interface CreateSessionOptions extends BotSessionOptions {
  workingDirectory?: string;
  agent?: string;
}

interface ResumeSessionOptions {
  workingDirectory?: string;
  agent?: string;
  onPermissionRequest: (
    request: { kind: 'shell'; toolCallId?: string; fullCommandText?: string; intention?: string },
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
    registerPermissionHandler: vi.fn(),
    ...overrides,
  };
}

function bridgeWithSession(session: FakeSession): {
  bridge: CopilotBridge;
  createSession: ReturnType<typeof vi.fn<(opts: CreateSessionOptions) => Promise<CopilotSession>>>;
  resumeSession: ReturnType<typeof vi.fn<(sessionId: string, opts: ResumeSessionOptions) => Promise<CopilotSession>>>;
  getOrCreateBotSession: ReturnType<typeof vi.fn<(workingDirectory: string, agent: string | undefined, opts: BotSessionOptions) => Promise<CopilotSession>>>;
  forceResumeSession: ReturnType<typeof vi.fn<(sessionId: string, opts: ResumeSessionOptions) => Promise<CopilotSession>>>;
} {
  const createSession = vi.fn(async (_opts: CreateSessionOptions) => session as unknown as CopilotSession);
  const resumeSession = vi.fn(async (_sessionId: string, _opts: ResumeSessionOptions) => session as unknown as CopilotSession);
  const getOrCreateBotSession = vi.fn(async (_workingDirectory: string, _agent: string | undefined, _opts: BotSessionOptions) => session as unknown as CopilotSession);
  const forceResumeSession = vi.fn(async (_sessionId: string, _opts: ResumeSessionOptions) => session as unknown as CopilotSession);
  return {
    bridge: { createSession, resumeSession, getOrCreateBotSession, forceResumeSession } as unknown as CopilotBridge,
    createSession,
    resumeSession,
    getOrCreateBotSession,
    forceResumeSession,
  };
}

function consoleLogCallsContain(spy: { mock: { calls: unknown[][] } }, expected: string): boolean {
  return spy.mock.calls.some((call) => call.some((arg) => String(arg).includes(expected)));
}

describe('AcpConnectionHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('initialize echoes protocolVersion with capabilities and authMethods []', async () => {
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
        result: {
          protocolVersion: '1',
          agentCapabilities: {},
          authMethods: [],
          serverCapabilities: { session: { resume: true } },
        },
      },
    ]);
  });

  it("session/new gets bot session and returns sessionId with workingDirectory '/test/workspace'", async () => {
    const sent: SentMessage[] = [];
    const session = fakeSession();
    const { bridge, createSession, getOrCreateBotSession } = bridgeWithSession(session);
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));

    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} }));

    expect(getOrCreateBotSession).toHaveBeenCalledOnce();
    expect(getOrCreateBotSession.mock.calls[0]?.[0]).toBe('/test/workspace');
    expect(createSession).not.toHaveBeenCalled();
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 2, result: { sessionId: 's1' } });
  });

  it('getOrCreateBotSession returns same cached bot session on second call', async () => {
    const bridge = Object.create(CopilotBridge.prototype) as CopilotBridge;
    const bridgeInternals = bridge as unknown as {
      sessions: Map<string, CopilotSession>;
      botSessionRegistry: Map<string, string>;
    };
    bridgeInternals.sessions = new Map();
    bridgeInternals.botSessionRegistry = new Map();
    const session = fakeSession();
    const createSession = vi.spyOn(bridge, 'createSession')
      .mockImplementation(async () => {
        bridgeInternals.sessions.set(session.sessionId, session as unknown as CopilotSession);
        return session as unknown as CopilotSession;
      });
    const firstPermissionHandler = vi.fn();
    const secondPermissionHandler = vi.fn();

    const first = await bridge.getOrCreateBotSession('/test/workspace', 'bob', {
      model: 'claude-sonnet-4.6',
      onPermissionRequest: firstPermissionHandler,
    });
    const second = await bridge.getOrCreateBotSession('/test/workspace', 'bob', {
      model: 'claude-sonnet-4.6',
      onPermissionRequest: secondPermissionHandler,
    });

    expect(first).toBe(second);
    expect(createSession).toHaveBeenCalledOnce();
    expect(session.registerPermissionHandler).toHaveBeenCalledOnce();
    expect(session.registerPermissionHandler).toHaveBeenCalledWith(secondPermissionHandler);
  });

  it('session/new logs session_open with acpSessionId', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sent: SentMessage[] = [];
    const session = fakeSession();
    const { bridge } = bridgeWithSession(session);
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));

    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} }));

    expect(consoleLogCallsContain(consoleLogSpy, 'session_open acpSessionId=s1')).toBe(true);
  });

  it('session/prompt waits for idle and returns stopReason idle', async () => {
    const sent: SentMessage[] = [];
    let subscriptionCount = 0;
    const session = fakeSession({
      on: vi.fn((handler: SessionHandler) => {
        subscriptionCount += 1;
        if (subscriptionCount === 1) {
          handler({ type: 'session.idle' } as SessionEvent);
        }
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
    expect(sent).toContainEqual({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', type: 'completed', content: '' },
    });
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 2, result: { stopReason: 'idle' } });
  });

  it('translates assistant.streaming_delta into simplified streaming update', async () => {
    const sent: SentMessage[] = [];
    let sessionHandler: SessionHandler | undefined;
    const session = fakeSession({
      on: vi.fn((handler: SessionHandler) => {
        sessionHandler = handler;
        return vi.fn();
      }),
    });
    const { bridge } = bridgeWithSession(session);
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }));

    sessionHandler?.({
      id: '1',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'assistant.streaming_delta',
      data: { deltaContent: 'hi' },
    } as unknown as SessionEvent);

    expect(sent).toContainEqual({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', type: 'streaming', content: 'hi' },
    });
  });

  it('forces bridge resume when sessionId is not in the in-memory map', async () => {
    const sent: SentMessage[] = [];
    let sessionHandler: SessionHandler | undefined;
    const session = fakeSession({
      sessionId: 'persisted-session',
      on: vi.fn((handler: SessionHandler) => {
        sessionHandler = handler;
        return vi.fn();
      }),
    });
    const { bridge, resumeSession, forceResumeSession } = bridgeWithSession(session);
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));

    await handler.handle(JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'session/resume',
      params: { sessionId: 'persisted-session' },
    }));

    expect(forceResumeSession).toHaveBeenCalledOnce();
    expect(forceResumeSession.mock.calls[0]?.[0]).toBe('persisted-session');
    expect(resumeSession).not.toHaveBeenCalled();
    expect(sent).toContainEqual({ jsonrpc: '2.0', id: 3, result: { sessionId: 'persisted-session' } });

    sessionHandler?.({
      id: '1',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'assistant.streaming_delta',
      data: { deltaContent: 'resumed' },
    } as unknown as SessionEvent);

    expect(sent).toContainEqual({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'persisted-session', type: 'streaming', content: 'resumed' },
    });
  });

  it('permission request parks and resolves on response', async () => {
    const sent: SentMessage[] = [];
    let permissionPromise: Promise<PermissionRequestResult> | undefined;
    const session = fakeSession();
    const getOrCreateBotSession = vi.fn(async (_workingDirectory: string, _agent: string | undefined, opts: BotSessionOptions) => {
      permissionPromise = Promise.resolve(opts.onPermissionRequest({ kind: 'shell' }, { sessionId: 's1' }));
      return session as unknown as CopilotSession;
    });
    const bridge = { getOrCreateBotSession } as unknown as CopilotBridge;
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

    await expect(permissionPromise).resolves.toEqual({ kind: 'approve-once' });
    await sessionNewPromise;
  });

  it('request_permission triggers permission_sent log with wsReqId and kind', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sent: SentMessage[] = [];
    let permissionPromise: Promise<PermissionRequestResult> | undefined;
    const session = fakeSession();
    const getOrCreateBotSession = vi.fn(async (_workingDirectory: string, _agent: string | undefined, opts: BotSessionOptions) => {
      permissionPromise = Promise.resolve(opts.onPermissionRequest({ kind: 'shell' }, { sessionId: 's1' }));
      return session as unknown as CopilotSession;
    });
    const bridge = { getOrCreateBotSession } as unknown as CopilotBridge;
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
    const requestId = request?.id as string;
    expect(consoleLogCallsContain(consoleLogSpy, `request_permission_sent acpSessionId=s1 wsReqId=${requestId} kind=shell`)).toBe(true);

    await handler.handle(JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      result: { decision: 'allow' },
    } satisfies JsonRpcResponse));
    await expect(permissionPromise).resolves.toEqual({ kind: 'approve-once' });
    await sessionNewPromise;
  });

  it('permission response logs permission_resume_received with decision', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sent: SentMessage[] = [];
    let permissionPromise: Promise<PermissionRequestResult> | undefined;
    const session = fakeSession();
    const getOrCreateBotSession = vi.fn(async (_workingDirectory: string, _agent: string | undefined, opts: BotSessionOptions) => {
      permissionPromise = Promise.resolve(opts.onPermissionRequest({ kind: 'shell' }, { sessionId: 's1' }));
      return session as unknown as CopilotSession;
    });
    const bridge = { getOrCreateBotSession } as unknown as CopilotBridge;
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
    const requestId = request?.id as string;
    consoleLogSpy.mockClear();

    await handler.handle(JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      result: { decision: 'allow' },
    } satisfies JsonRpcResponse));

    expect(consoleLogCallsContain(consoleLogSpy, `permission_resume_received wsReqId=${requestId} decision=allow`)).toBe(true);
    await expect(permissionPromise).resolves.toEqual({ kind: 'approve-once' });
    await sessionNewPromise;
  });

  it('permission response logs deny decision as reject', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sent: SentMessage[] = [];
    let permissionPromise: Promise<PermissionRequestResult> | undefined;
    const session = fakeSession();
    const getOrCreateBotSession = vi.fn(async (_workingDirectory: string, _agent: string | undefined, opts: BotSessionOptions) => {
      permissionPromise = Promise.resolve(opts.onPermissionRequest({ kind: 'shell' }, { sessionId: 's1' }));
      return session as unknown as CopilotSession;
    });
    const bridge = { getOrCreateBotSession } as unknown as CopilotBridge;
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
    const requestId = request?.id as string;
    consoleLogSpy.mockClear();

    await handler.handle(JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      result: { decision: 'deny' },
    } satisfies JsonRpcResponse));

    expect(consoleLogCallsContain(consoleLogSpy, `permission_resume_received wsReqId=${requestId} decision=reject`)).toBe(true);
    expect(consoleLogCallsContain(consoleLogSpy, `permission_resume_received wsReqId=${requestId} decision=deny`)).toBe(false);
    await expect(permissionPromise).resolves.toEqual({ kind: 'reject' });
    await sessionNewPromise;
  });

  it('permission request forwards full request details', async () => {
    const sent: SentMessage[] = [];
    const session = fakeSession();
    const getOrCreateBotSession = vi.fn(async (_workingDirectory: string, _agent: string | undefined, opts: BotSessionOptions) => {
      void opts.onPermissionRequest({
        kind: 'shell',
        fullCommandText: 'ls /tmp',
        intention: 'List a directory',
      }, { sessionId: 's1' });
      return session as unknown as CopilotSession;
    });
    const bridge = { getOrCreateBotSession } as unknown as CopilotBridge;
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
    expect(request?.params).toMatchObject({
      kind: 'shell',
      request: {
        kind: 'shell',
        fullCommandText: 'ls /tmp',
        intention: 'List a directory',
      },
    });

    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: request?.id as string,
      result: { decision: 'allow' },
    };
    await handler.handle(JSON.stringify(response));
    await sessionNewPromise;
  });

  it('permission request denial resolves to reject', async () => {
    const sent: SentMessage[] = [];
    let permissionPromise: Promise<PermissionRequestResult> | undefined;
    const session = fakeSession();
    const getOrCreateBotSession = vi.fn(async (_workingDirectory: string, _agent: string | undefined, opts: BotSessionOptions) => {
      permissionPromise = Promise.resolve(opts.onPermissionRequest({ kind: 'shell' }, { sessionId: 's1' }));
      return session as unknown as CopilotSession;
    });
    const bridge = { getOrCreateBotSession } as unknown as CopilotBridge;
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

    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: request?.id as string,
      result: { decision: 'deny' },
    };
    await handler.handle(JSON.stringify(response));

    await expect(permissionPromise).resolves.toEqual({ kind: 'reject' });
    await sessionNewPromise;
  });

  it('session/close logs session_close', async () => {
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sent: SentMessage[] = [];
    const session = fakeSession();
    const { bridge } = bridgeWithSession(session);
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }));
    consoleLogSpy.mockClear();

    await handler.handle(JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/close',
      params: { sessionId: 's1' },
    }));

    expect(consoleLogCallsContain(consoleLogSpy, 'session_close acpSessionId=s1')).toBe(true);
  });

  it('closeAll only unsubscribes listeners, does not disconnect or abort the session', async () => {
    const sent: SentMessage[] = [];
    const unsubscribe = vi.fn();
    const session = fakeSession({ on: vi.fn(() => unsubscribe) });
    const { bridge } = bridgeWithSession(session);
    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }));

    await handler.closeAll();

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.disconnect).not.toHaveBeenCalled();
  });
});
