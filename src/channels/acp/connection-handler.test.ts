import { afterEach, describe, expect, it, vi } from 'vitest';
import { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import type { CopilotSession, PermissionHandler, PermissionRequestResult, SessionEvent } from '@github/copilot-sdk';
import type { JsonRpcResponse } from './types.js';
import type { SessionState } from '../../core/session-types.js';
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
  getSessionState: ReturnType<typeof vi.fn>;
  getAllSessionStates: ReturnType<typeof vi.fn>;
  subscribeToSession: ReturnType<typeof vi.fn>;
  unsubscribeFromSession: ReturnType<typeof vi.fn>;
  setSessionStatus: ReturnType<typeof vi.fn>;
} {
  const createSession = vi.fn(async (_opts: CreateSessionOptions) => session as unknown as CopilotSession);
  const resumeSession = vi.fn(async (_sessionId: string, _opts: ResumeSessionOptions) => session as unknown as CopilotSession);
  const getOrCreateBotSession = vi.fn(async (_workingDirectory: string, _agent: string | undefined, _opts: BotSessionOptions) => session as unknown as CopilotSession);
  const forceResumeSession = vi.fn(async (_sessionId: string, _opts: ResumeSessionOptions) => session as unknown as CopilotSession);
  const getSessionState = vi.fn((_id: string) => null as SessionState | null);
  const getAllSessionStates = vi.fn(async () => [] as SessionState[]);
  const subscribeToSession = vi.fn();
  const unsubscribeFromSession = vi.fn();
  const setSessionStatus = vi.fn();
  return {
    bridge: { createSession, resumeSession, getOrCreateBotSession, forceResumeSession, getSessionState, getAllSessionStates, subscribeToSession, unsubscribeFromSession, setSessionStatus } as unknown as CopilotBridge,
    createSession,
    resumeSession,
    getOrCreateBotSession,
    forceResumeSession,
    getSessionState,
    getAllSessionStates,
    subscribeToSession,
    unsubscribeFromSession,
    setSessionStatus,
  };
}


function defaultState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    id: 's1',
    agent: 'bob',
    status: 'idle',
    currentTurnIndex: 3,
    pendingPermissions: [],
    updatedAt: '2026-05-20T15:00:00.000Z',
    ...overrides,
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
      sessionStatuses: Map<string, unknown>;
      sessionAgents: Map<string, string | null>;
      sessionUpdatedAt: Map<string, string>;
      sessionSubscribers: Map<string, Set<(state: SessionState) => void>>;
    };
    bridgeInternals.sessions = new Map();
    bridgeInternals.botSessionRegistry = new Map();
    bridgeInternals.sessionStatuses = new Map();
    bridgeInternals.sessionAgents = new Map();
    bridgeInternals.sessionUpdatedAt = new Map();
    bridgeInternals.sessionSubscribers = new Map();
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
    const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn() } as unknown as CopilotBridge;
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
    const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn() } as unknown as CopilotBridge;
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
    const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn() } as unknown as CopilotBridge;
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
    const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn() } as unknown as CopilotBridge;
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
    const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn() } as unknown as CopilotBridge;
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
    const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn() } as unknown as CopilotBridge;
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

  describe('session query methods', () => {
    it('session/get returns state for known session', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const state = defaultState({ id: 's1' });
      (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(state);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/get', params: { sessionId: 's1' } }));
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ jsonrpc: '2.0', id: 1, result: state });
    });

    it('session/get returns -32001 for unknown session', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(null);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/get', params: { sessionId: 'unknown-id' } }));
      expect(sent[0]).toMatchObject({ error: { code: -32001 } });
    });

    it('session/get returns -32600 when sessionId missing', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/get', params: {} }));
      expect(sent[0]).toMatchObject({ error: { code: -32600 } });
    });

    it('session/list returns sessions array', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const state = defaultState({ id: 's1' });
      (bridge.getAllSessionStates as ReturnType<typeof vi.fn>).mockResolvedValue([state]);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'session/list', params: {} }));
      expect(sent[0]).toMatchObject({ id: 4, result: { sessions: [state] } });
    });

    it('session/subscribe returns ack and registers callback with bridge', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const state = defaultState({ id: 's1' });
      (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(state);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'session/subscribe', params: { sessionId: 's1' } }));
      expect(sent[0]).toMatchObject({ id: 5, result: { subscribed: true, sessionId: 's1' } });
      expect(bridge.subscribeToSession).toHaveBeenCalledWith('s1', expect.any(Function));
    });

    it('session/subscribe sends session/state_changed when callback fires', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const state = defaultState({ id: 's1' });
      (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(state);
      let capturedCb: ((s: SessionState) => void) | null = null;
      (bridge.subscribeToSession as ReturnType<typeof vi.fn>).mockImplementation(
        (_id: string, cb: (s: SessionState) => void) => { capturedCb = cb; }
      );
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'session/subscribe', params: { sessionId: 's1' } }));
      sent.length = 0;
      const updatedState = defaultState({ id: 's1', status: 'in_progress' });
      capturedCb!(updatedState);
      expect(sent[0]).toMatchObject({ method: 'session/state_changed', params: updatedState });
    });

    it('session/subscribe is idempotent - second subscribe cancels first', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const state = defaultState({ id: 's1' });
      (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(state);
      const callbacks: Array<(s: SessionState) => void> = [];
      (bridge.subscribeToSession as ReturnType<typeof vi.fn>).mockImplementation(
        (_id: string, cb: (s: SessionState) => void) => callbacks.push(cb)
      );
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'session/subscribe', params: { sessionId: 's1' } }));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'session/subscribe', params: { sessionId: 's1' } }));
      expect(bridge.unsubscribeFromSession).toHaveBeenCalledTimes(1);
      expect(bridge.subscribeToSession).toHaveBeenCalledTimes(2);
    });

    it('session/unsubscribe calls unsubscribeFromSession and returns success', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const state = defaultState({ id: 's1' });
      (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(state);
      (bridge.subscribeToSession as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'session/subscribe', params: { sessionId: 's1' } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/unsubscribe', params: { sessionId: 's1' } }));
      expect(sent[0]).toMatchObject({ id: 7, result: {} });
      expect(bridge.unsubscribeFromSession).toHaveBeenCalledWith('s1', expect.any(Function));
    });

    it('session/unsubscribe for non-subscribed session returns success', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'session/unsubscribe', params: { sessionId: 'not-subscribed' } }));
      expect(sent[0]).toMatchObject({ id: 8, result: {} });
    });

    it('closeAll cleans up subscriptions', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const state = defaultState({ id: 's1' });
      (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(state);
      (bridge.subscribeToSession as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'session/subscribe', params: { sessionId: 's1' } }));
      await handler.closeAll();
      expect(bridge.unsubscribeFromSession).toHaveBeenCalledTimes(1);
    });

    it('session.in_progress SDK event triggers setSessionStatus in_progress', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      let capturedHandler: ((event: SessionEvent) => void) | null = null;
      session.on.mockImplementation((h: (event: SessionEvent) => void) => {
        capturedHandler = h;
        return vi.fn();
      });
      const { bridge } = bridgeWithSession(session);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }));
      capturedHandler!({ type: 'session.in_progress' } as SessionEvent);
      expect(bridge.setSessionStatus).toHaveBeenCalledWith('s1', 'in_progress');
    });
  });

});
