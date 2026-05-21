import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import type { CopilotSession, PermissionHandler, PermissionRequestResult, SessionEvent } from '@github/copilot-sdk';
import type { JsonRpcResponse } from './types.js';
import type { SessionState } from '../../core/session-types.js';
import type { StoredTurn } from '../../core/session-store-reader.js';
import { AcpConnectionHandler } from './connection-handler.js';
import { loadConfig, _resetConfigForTest } from '../../config.js';

const { mockSpan, mockTracer, mockPropagationInject, mockPropagationExtract } = vi.hoisted(() => {
  const mockSpan = { setAttribute: vi.fn(), setStatus: vi.fn(), end: vi.fn() };
  const mockTracer = { startSpan: vi.fn(() => mockSpan) };
  const mockPropagationInject = vi.fn((_ctx: unknown, carrier: Record<string, string>) => { carrier['traceparent'] = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1-bbbbbbbbbbbbbbbb-01'; });
  const mockPropagationExtract = vi.fn((_ctx: unknown, _carrier: unknown) => _ctx);
  return { mockSpan, mockTracer, mockPropagationInject, mockPropagationExtract };
});
vi.mock('../../telemetry.js', () => ({ getTracer: () => mockTracer, propagation: { inject: mockPropagationInject, extract: mockPropagationExtract }, otelContext: { active: vi.fn(() => ({})), with: vi.fn((_ctx: unknown, fn: () => unknown) => fn()) }, SpanStatusCode: { ERROR: 2, OK: 1, UNSET: 0 } }));


const permissionConfigPath = 'scratch-acp-connection-handler-config.json';

beforeEach(() => {
  _resetConfigForTest();
  fs.writeFileSync(permissionConfigPath, JSON.stringify({
    platforms: {
      mattermost: {
        url: 'http://localhost:8065',
        bots: { copilot: { token: 'test-token-123' } },
      },
    },
    channels: [],
    defaults: { model: 'claude-sonnet-4.6', triggerMode: 'mention' },
    permissions: {},
  }));
  loadConfig(permissionConfigPath);
  mockSpan.setAttribute.mockClear();
  mockSpan.setStatus.mockClear();
  mockSpan.end.mockClear();
  mockTracer.startSpan.mockClear();
  mockPropagationInject.mockClear();
  mockPropagationExtract.mockClear();
});

afterEach(() => {
  _resetConfigForTest();
  fs.rmSync(permissionConfigPath, { force: true });
});

type SentMessage = Record<string, unknown>;
type SessionHandler = (event: SessionEvent) => void;
type TestPermissionRequest = { kind: string; toolCallId?: string; fullCommandText?: string; intention?: string; path?: string };

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
    request: TestPermissionRequest,
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
    request: TestPermissionRequest,
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
  getSessionTranscript: ReturnType<typeof vi.fn<(id: string, since: number, limit: number) => { turns: StoredTurn[]; hasMore: boolean; sessionFound: boolean }>>;
  setSessionStatus: ReturnType<typeof vi.fn>;
  addPendingPermission: ReturnType<typeof vi.fn>;
  removePendingPermission: ReturnType<typeof vi.fn>;
} {
  const createSession = vi.fn(async (_opts: CreateSessionOptions) => session as unknown as CopilotSession);
  const resumeSession = vi.fn(async (_sessionId: string, _opts: ResumeSessionOptions) => session as unknown as CopilotSession);
  const getOrCreateBotSession = vi.fn(async (_workingDirectory: string, _agent: string | undefined, _opts: BotSessionOptions) => session as unknown as CopilotSession);
  const forceResumeSession = vi.fn(async (_sessionId: string, _opts: ResumeSessionOptions) => session as unknown as CopilotSession);
  const getSessionState = vi.fn((_id: string) => null as SessionState | null);
  const getAllSessionStates = vi.fn(async () => [] as SessionState[]);
  const subscribeToSession = vi.fn();
  const unsubscribeFromSession = vi.fn();
  const getSessionTranscript = vi.fn((_id: string, _since: number, _limit: number) => ({
    turns: [] as StoredTurn[],
    hasMore: false,
    sessionFound: false,
  }));
  const setSessionStatus = vi.fn();
  const addPendingPermission = vi.fn();
  const removePendingPermission = vi.fn();
  return {
    bridge: { createSession, resumeSession, getOrCreateBotSession, forceResumeSession, getSessionState, getAllSessionStates, subscribeToSession, unsubscribeFromSession, getSessionTranscript, setSessionStatus, addPendingPermission, removePendingPermission } as unknown as CopilotBridge,
    createSession,
    resumeSession,
    getOrCreateBotSession,
    forceResumeSession,
    getSessionState,
    getAllSessionStates,
    subscribeToSession,
    unsubscribeFromSession,
    getSessionTranscript,
    setSessionStatus,
    addPendingPermission,
    removePendingPermission,
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
    expect(sent).toContainEqual(expect.objectContaining({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', type: 'completed', content: '' },
    }));
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

    expect(sent).toContainEqual(expect.objectContaining({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 's1', type: 'streaming', content: 'hi' },
    }));
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

    expect(sent).toContainEqual(expect.objectContaining({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'persisted-session', type: 'streaming', content: 'resumed' },
    }));
  });

  it('permission request parks and resolves on response', async () => {
    const sent: SentMessage[] = [];
    let permissionPromise: Promise<PermissionRequestResult> | undefined;
    const session = fakeSession();
    const getOrCreateBotSession = vi.fn(async (_workingDirectory: string, _agent: string | undefined, opts: BotSessionOptions) => {
      permissionPromise = Promise.resolve(opts.onPermissionRequest({ kind: 'shell' }, { sessionId: 's1' }));
      return session as unknown as CopilotSession;
    });
    const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn(), addPendingPermission: vi.fn(), removePendingPermission: vi.fn() } as unknown as CopilotBridge;
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
    const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn(), addPendingPermission: vi.fn(), removePendingPermission: vi.fn() } as unknown as CopilotBridge;
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
    const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn(), addPendingPermission: vi.fn(), removePendingPermission: vi.fn() } as unknown as CopilotBridge;
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
    const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn(), addPendingPermission: vi.fn(), removePendingPermission: vi.fn() } as unknown as CopilotBridge;
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
    const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn(), addPendingPermission: vi.fn(), removePendingPermission: vi.fn() } as unknown as CopilotBridge;
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
    const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn(), addPendingPermission: vi.fn(), removePendingPermission: vi.fn() } as unknown as CopilotBridge;
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

  describe('session/transcript', () => {
    it('returns turns from session-store', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const fakeTurns: StoredTurn[] = [
        { turnIndex: 0, userMessage: 'hello', assistantResponse: 'hi there', timestamp: '2026-05-20T01:00:00.000Z' },
        { turnIndex: 1, userMessage: 'how are you?', assistantResponse: 'great', timestamp: '2026-05-20T01:01:00.000Z' },
      ];
      (bridge.getSessionTranscript as ReturnType<typeof vi.fn>).mockReturnValue({
        turns: fakeTurns, hasMore: false, sessionFound: true,
      });
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/transcript', params: { sessionId: 's1', since: 0 } }));
      expect(sent[0]).toMatchObject({
        id: 1,
        result: {
          sessionId: 's1',
          turns: [
            { turnIndex: 0, userMessage: 'hello', assistantResponse: 'hi there' },
            { turnIndex: 1, userMessage: 'how are you?', assistantResponse: 'great' },
          ],
          hasMore: false,
        },
      });
    });

    it('returns -32001 when session not found in session-store', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      (bridge.getSessionTranscript as ReturnType<typeof vi.fn>).mockReturnValue({ turns: [], hasMore: false, sessionFound: false });
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/transcript', params: { sessionId: 'ghost-id' } }));
      expect(sent[0]).toMatchObject({ error: { code: -32001 } });
    });

    it('returns empty turns when session has no turns', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      (bridge.getSessionTranscript as ReturnType<typeof vi.fn>).mockReturnValue({ turns: [], hasMore: false, sessionFound: true });
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/transcript', params: { sessionId: 's1' } }));
      expect(sent[0]).toMatchObject({ id: 3, result: { sessionId: 's1', turns: [], hasMore: false } });
    });

    it('returns hasMore: true when more turns exist', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      (bridge.getSessionTranscript as ReturnType<typeof vi.fn>).mockReturnValue({
        turns: [{ turnIndex: 0, userMessage: 'a', assistantResponse: 'b', timestamp: '2026-01-01T00:00:00.000Z' }],
        hasMore: true, sessionFound: true,
      });
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'session/transcript', params: { sessionId: 's1', limit: 1 } }));
      expect(sent[0]).toMatchObject({ id: 4, result: { hasMore: true } });
    });

    it('returns -32600 when sessionId missing', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'session/transcript', params: {} }));
      expect(sent[0]).toMatchObject({ error: { code: -32600 } });
    });

    it('returns -32600 when since < 0', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'session/transcript', params: { sessionId: 's1', since: -1 } }));
      expect(sent[0]).toMatchObject({ error: { code: -32600 } });
    });

    it('returns -32600 when limit > 500', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      sent.length = 0;
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/transcript', params: { sessionId: 's1', limit: 501 } }));
      expect(sent[0]).toMatchObject({ error: { code: -32600 } });
    });

    it('passes since and limit to bridge.getSessionTranscript', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      (bridge.getSessionTranscript as ReturnType<typeof vi.fn>).mockReturnValue({ turns: [], hasMore: false, sessionFound: true });
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '0.1', clientCapabilities: {} } }));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'session/transcript', params: { sessionId: 's1', since: 5, limit: 50 } }));
      expect(bridge.getSessionTranscript).toHaveBeenCalledWith('s1', 5, 50);
    });
  });

  describe('OTel instrumentation', () => {
    it('starts acp.session.new span on session/new', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession();
      const { bridge } = bridgeWithSession(session);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));

      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }));

      expect(mockTracer.startSpan.mock.calls.some((call) => call[0] === 'acp.session.new')).toBe(true);
      expect(mockSpan.end).toHaveBeenCalledOnce();
    });

    it('starts acp.session.prompt span on session/prompt', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession({
        on: vi.fn((handler: SessionHandler) => {
          handler({ type: 'session.idle' } as SessionEvent);
          return vi.fn();
        }),
      });
      const { bridge } = bridgeWithSession(session);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }));
      const sessionId = (sent.find((msg) => msg.id === 1)?.result as { sessionId: string }).sessionId;
      mockSpan.setAttribute.mockClear();
      mockSpan.end.mockClear();
      mockTracer.startSpan.mockClear();

      await handler.handle(JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/prompt',
        params: { sessionId, prompt: 'hello' },
      }));

      expect(mockTracer.startSpan.mock.calls.some((call) => call[0] === 'acp.session.prompt')).toBe(true);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('acp.session_id', sessionId);
      expect(mockSpan.end).toHaveBeenCalled();
    });

    it('extracts traceparent from session/prompt envelope', async () => {
      const sent: SentMessage[] = [];
      const session = fakeSession({
        on: vi.fn((handler: SessionHandler) => {
          handler({ type: 'session.idle' } as SessionEvent);
          return vi.fn();
        }),
      });
      const { bridge } = bridgeWithSession(session);
      const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
      await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: {} }));
      const sessionId = (sent.find((msg) => msg.id === 1)?.result as { sessionId: string }).sessionId;
      mockPropagationExtract.mockClear();

      await handler.handle(JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'session/prompt',
        params: { sessionId, prompt: 'hi' },
        traceparent: '00-abc-def-01',
      }));

      expect(mockPropagationExtract.mock.calls.some((call) => JSON.stringify(call[1]) === JSON.stringify({ traceparent: '00-abc-def-01' }))).toBe(true);
    });

    it('injects traceparent into outbound session/request_permission', async () => {
      const sent: SentMessage[] = [];
      let permissionPromise: Promise<PermissionRequestResult> | undefined;
      const session = fakeSession();
      const getOrCreateBotSession = vi.fn(async (_workingDirectory: string, _agent: string | undefined, opts: BotSessionOptions) => {
        permissionPromise = Promise.resolve(opts.onPermissionRequest({ kind: 'shell' }, { sessionId: 's1' }));
        return session as unknown as CopilotSession;
      });
      const bridge = { getOrCreateBotSession, setSessionStatus: vi.fn(), addPendingPermission: vi.fn(), removePendingPermission: vi.fn() } as unknown as CopilotBridge;
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
      expect(request?.traceparent).toBe('00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1-bbbbbbbbbbbbbbbb-01');

      await handler.handle(JSON.stringify({
        jsonrpc: '2.0',
        id: request?.id as string,
        result: { decision: 'allow' },
      } satisfies JsonRpcResponse));
      await expect(permissionPromise).resolves.toEqual({ kind: 'approve-once' });
      await sessionNewPromise;
    });
  });

});


describe('AcpConnectionHandler - permission policy pre-check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-allows a request when evaluateConfigPermissions returns allow', async () => {
    const sent: SentMessage[] = [];
    const session = fakeSession();
    let capturedHandler: ((request: TestPermissionRequest, invocation: { sessionId: string }) => Promise<PermissionRequestResult>) | undefined;

    const { bridge } = bridgeWithSession(session);
    (bridge.getOrCreateBotSession as ReturnType<typeof vi.fn>).mockImplementation(
      async (_wd: string, _agent: string | undefined, opts: BotSessionOptions) => {
        capturedHandler = opts.onPermissionRequest;
        return session as unknown as CopilotSession;
      },
    );
    (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(defaultState());

    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} }));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'new', method: 'session/new', params: {} }));

    const result = await capturedHandler!({ kind: 'read', path: '/test/workspace/file.ts' }, { sessionId: 's1' });

    expect(result).toEqual({ kind: 'approve-once' });
    expect(sent.some((m) => m.method === 'session/request_permission')).toBe(false);
    expect((bridge.addPendingPermission as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('auto-denies a request when evaluateConfigPermissions returns deny via hardcoded deny rule', async () => {
    const sent: SentMessage[] = [];
    const session = fakeSession();
    let capturedHandler: ((request: TestPermissionRequest, invocation: { sessionId: string }) => Promise<PermissionRequestResult>) | undefined;

    const { bridge } = bridgeWithSession(session);
    (bridge.getOrCreateBotSession as ReturnType<typeof vi.fn>).mockImplementation(
      async (_wd: string, _agent: string | undefined, opts: BotSessionOptions) => {
        capturedHandler = opts.onPermissionRequest;
        return session as unknown as CopilotSession;
      },
    );
    (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(defaultState());

    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} }));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'new', method: 'session/new', params: {} }));

    const result = await capturedHandler!({ kind: 'shell', fullCommandText: 'rm -rf /' }, { sessionId: 's1' });

    expect(result).toEqual({ kind: 'reject' });
    expect(sent.some((m) => m.method === 'session/request_permission')).toBe(false);
    expect((bridge.addPendingPermission as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('forwards shell echo hello and calls addPendingPermission, then response calls removePendingPermission', async () => {
    const sent: SentMessage[] = [];
    const session = fakeSession();
    let capturedHandler: ((request: TestPermissionRequest, invocation: { sessionId: string }) => Promise<PermissionRequestResult>) | undefined;

    const { bridge } = bridgeWithSession(session);
    (bridge.getOrCreateBotSession as ReturnType<typeof vi.fn>).mockImplementation(
      async (_wd: string, _agent: string | undefined, opts: BotSessionOptions) => {
        capturedHandler = opts.onPermissionRequest;
        return session as unknown as CopilotSession;
      },
    );
    (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(defaultState());

    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} }));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'new', method: 'session/new', params: {} }));

    const permissionPromise = capturedHandler!({ kind: 'shell', fullCommandText: 'echo hello' }, { sessionId: 's1' });

    const permRequest = sent.find((m) => m.method === 'session/request_permission');
    expect(permRequest).toBeDefined();
    expect((bridge.addPendingPermission as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((bridge.addPendingPermission as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe('s1');
    expect((bridge.addPendingPermission as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({ kind: 'shell' });

    const requestId = permRequest?.id as string;
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { decision: 'allow' } }));

    await expect(permissionPromise).resolves.toEqual({ kind: 'approve-once' });
    expect((bridge.removePendingPermission as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((bridge.removePendingPermission as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['s1', requestId]);
  });
});

describe('AcpConnectionHandler - pendingPermissions in session state', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });



  it('CopilotBridge stores pendingPermissions in session state and notifies subscribers', () => {
    const bridge = Object.create(CopilotBridge.prototype) as CopilotBridge;
    const bridgeInternals = bridge as unknown as {
      sessionStatuses: Map<string, unknown>;
      sessionAgents: Map<string, string | null>;
      sessionUpdatedAt: Map<string, string>;
      sessionSubscribers: Map<string, Set<(state: SessionState) => void>>;
      sessionPendingPermissions: Map<string, Map<string, { requestId: string; kind: string; requestedAt: string }>>;
    };
    bridgeInternals.sessionStatuses = new Map([['s1', 'idle']]);
    bridgeInternals.sessionAgents = new Map([['s1', 'bob']]);
    bridgeInternals.sessionUpdatedAt = new Map([['s1', '2026-05-20T20:00:00.000Z']]);
    bridgeInternals.sessionSubscribers = new Map();
    bridgeInternals.sessionPendingPermissions = new Map();
    const observed: SessionState[] = [];
    bridge.subscribeToSession('s1', (state) => observed.push(state));

    bridge.addPendingPermission('s1', {
      requestId: 'req-1',
      kind: 'shell',
      requestedAt: '2026-05-20T20:01:00.000Z',
    });

    expect(bridge.getSessionState('s1')?.pendingPermissions).toEqual([
      { requestId: 'req-1', kind: 'shell', requestedAt: '2026-05-20T20:01:00.000Z' },
    ]);
    expect(observed.at(-1)?.pendingPermissions).toEqual([
      { requestId: 'req-1', kind: 'shell', requestedAt: '2026-05-20T20:01:00.000Z' },
    ]);

    bridge.removePendingPermission('s1', 'req-1');

    expect(bridge.getSessionState('s1')?.pendingPermissions).toEqual([]);
    expect(observed.at(-1)?.pendingPermissions).toEqual([]);
  });

  it('session/get returns pendingPermissions from bridge state', async () => {
    const sent: SentMessage[] = [];
    const session = fakeSession();
    const { bridge } = bridgeWithSession(session);

    const pendingPerm = {
      requestId: 'req-abc',
      kind: 'shell',
      requestedAt: '2026-05-20T20:00:00.000Z',
    };
    (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(
      defaultState({ pendingPermissions: [pendingPerm] }),
    );

    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'g1', method: 'session/get', params: { sessionId: 's1' } }));

    const resp = sent.find((m) => (m as { id?: string }).id === 'g1');
    expect(resp).toBeDefined();
    expect((resp as { result?: { pendingPermissions?: unknown[] } }).result?.pendingPermissions).toEqual([pendingPerm]);
  });
});
