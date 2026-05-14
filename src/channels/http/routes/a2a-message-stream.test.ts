import type { SessionEvent } from '@github/copilot-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import type { PendingPermissionStore } from '../pending-permission-store.js';
import type { PermissionStore } from '../permission-store.js';
import { RunRegistry } from '../run-registry.js';
import { registerA2AMessageStreamRoute, type A2AMessageStreamRouteDeps } from './a2a-message-stream.js';

const fullAccessHeader = { authorization: 'Bearer test-secret-full' };
const readOnlyHeader = { authorization: 'Bearer test-secret-readonly' };
const limitedAgentHeader = { authorization: 'Bearer test-secret-limited' };

const authConfig: AuthConfig = {
  keys: new Map([
    ['full-access', {
      secret: 'test-secret-full',
      allowedAgents: ['*'],
      allowedOps: ['*'],
    }],
    ['read-only', {
      secret: 'test-secret-readonly',
      allowedAgents: ['bot-a'],
      allowedOps: ['agent:read'],
    }],
    ['limited-agent', {
      secret: 'test-secret-limited',
      allowedAgents: ['bot-b'],
      allowedOps: ['agent:execute'],
    }],
  ]),
};

const testBots = {
  'bot-a': {},
  'bot-b': {},
};

const validPayload = {
  message: {
    role: 'user' as const,
    parts: [{ kind: 'text' as const, text: 'hello from A2A' }],
    messageId: 'message-1',
    contextId: 'fixed-card-1',
  },
};

const sdkEvent = (type: string, data: Record<string, unknown> = {}, extras: Record<string, unknown> = {}): SessionEvent => ({
  type,
  data,
  id: `${type}-id`,
  timestamp: '2026-01-01T00:00:00.000Z',
  parentId: null,
  ...extras,
} as unknown as SessionEvent);

type SseFrame = { event: string; data: any };

const parseSseFrames = (body: string): SseFrame[] => body.trim().split('\n\n').filter(Boolean).map((frame) => {
  const lines = frame.split('\n');
  const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length) ?? '';
  const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length) ?? '{}';
  return { event, data: JSON.parse(data) };
});

describe('registerA2AMessageStreamRoute', () => {
  let app: FastifyInstance;
  let deps: A2AMessageStreamRouteDeps;
  let runRegistry: RunRegistry;
  let dispatchInboundMessage: ReturnType<typeof vi.fn>;
  let createSessionWithPermissions: ReturnType<typeof vi.fn>;
  let checkPermission: ReturnType<typeof vi.fn>;
  let subscribeToSessionEvents: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let capturedHandler: ((sessionId: string, channelId: string, event: any) => void) | undefined;
  let capturedRequestRaw: IncomingMessage | undefined;

  beforeEach(() => {
    runRegistry = new RunRegistry();
    dispatchInboundMessage = vi.fn();
    createSessionWithPermissions = vi.fn(async (channelId: string) => ({ sessionId: channelId }));
    checkPermission = vi.fn().mockResolvedValue(null);
    unsubscribe = vi.fn();
    capturedHandler = undefined;
    capturedRequestRaw = undefined;
    subscribeToSessionEvents = vi.fn((_channelId, handler) => {
      capturedHandler = handler;
      return unsubscribe;
    });
    deps = {
      adapter: { dispatchInboundMessage } as Partial<A2AMessageStreamRouteDeps['adapter']> as A2AMessageStreamRouteDeps['adapter'],
      bots: testBots,
      runRegistry,
      permissionStore: { shouldApprove: vi.fn() } as unknown as PermissionStore,
      pendingPermissionStore: { park: vi.fn() } as unknown as PendingPermissionStore,
      checkPermission,
      createSessionWithPermissions,
      subscribeToSessionEvents,
      getSession: vi.fn().mockReturnValue({ getMessages: vi.fn().mockResolvedValue([]) }),
    };

    app = Fastify({ logger: false });
    registerAuthHook(app, authConfig);
    app.addHook('onRequest', async (request) => {
      if (request.url === '/agents/bot-a/message:stream') {
        capturedRequestRaw = request.raw;
      }
    });
    registerA2AMessageStreamRoute(app, deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns text/event-stream content-type for a valid request', async () => {
    const responsePromise = app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:stream',
      headers: fullAccessHeader,
      payload: validPayload,
    });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    capturedHandler?.('fixed-card-1', 'fixed-card-1', sdkEvent('session.idle'));
    const response = await responsePromise;

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
  });

  it('writes the initial task frame first', async () => {
    const responsePromise = app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:stream',
      headers: fullAccessHeader,
      payload: validPayload,
    });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    capturedHandler?.('fixed-card-1', 'fixed-card-1', sdkEvent('session.idle'));
    const frames = parseSseFrames((await responsePromise).body);

    expect(frames[0]).toMatchObject({
      event: 'task',
      data: {
        id: 'fixed-card-1',
        contextId: 'fixed-card-1',
        kind: 'task',
        status: { state: 'submitted' },
      },
    });
  });

  it('streams assistant.message_delta as an append artifact update', async () => {
    const responsePromise = app.inject({ method: 'POST', url: '/agents/bot-a/message:stream', headers: fullAccessHeader, payload: validPayload });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    capturedHandler?.('fixed-card-1', 'fixed-card-1', sdkEvent('assistant.message_delta', { deltaContent: 'hel' }));
    capturedHandler?.('fixed-card-1', 'fixed-card-1', sdkEvent('session.idle'));
    const frames = parseSseFrames((await responsePromise).body);

    expect(frames[1]).toMatchObject({
      event: 'artifact-update',
      data: {
        append: true,
        lastChunk: false,
        artifact: { parts: [{ kind: 'text', text: 'hel' }] },
      },
    });
  });

  it('streams assistant.message as a final artifact update', async () => {
    const responsePromise = app.inject({ method: 'POST', url: '/agents/bot-a/message:stream', headers: fullAccessHeader, payload: validPayload });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    capturedHandler?.('fixed-card-1', 'fixed-card-1', sdkEvent('assistant.message', { content: 'hello' }));
    capturedHandler?.('fixed-card-1', 'fixed-card-1', sdkEvent('session.idle'));
    const frames = parseSseFrames((await responsePromise).body);

    expect(frames[1]).toMatchObject({
      event: 'artifact-update',
      data: {
        append: false,
        lastChunk: true,
        artifact: { parts: [{ kind: 'text', text: 'hello' }] },
      },
    });
  });

  it('streams session.idle as a final completed status update and ends', async () => {
    const responsePromise = app.inject({ method: 'POST', url: '/agents/bot-a/message:stream', headers: fullAccessHeader, payload: validPayload });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    capturedHandler?.('fixed-card-1', 'fixed-card-1', sdkEvent('session.idle'));
    const frames = parseSseFrames((await responsePromise).body);

    expect(frames[1]).toMatchObject({
      event: 'status-update',
      data: { status: { state: 'completed' }, final: true },
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('streams permission requests through the registry emitter path', async () => {
    const responsePromise = app.inject({ method: 'POST', url: '/agents/bot-a/message:stream', headers: fullAccessHeader, payload: validPayload });

    await vi.waitFor(() => expect(runRegistry.getEmitter('fixed-card-1')).toBeDefined());
    runRegistry.getEmitter('fixed-card-1')?.(sdkEvent('bridge.permission_request', { toolName: 'bash' }));
    capturedHandler?.('fixed-card-1', 'fixed-card-1', sdkEvent('session.idle'));
    const frames = parseSseFrames((await responsePromise).body);

    expect(frames[1]).toMatchObject({
      event: 'status-update',
      data: { status: { state: 'input-required' }, final: false },
    });
    expect(frames[1]?.data.status.message.parts[0].text).toBe('Permission required: bash');
  });

  it('returns JSON 400 when message is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:stream',
      headers: fullAccessHeader,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ error: 'Missing required field: message' });
  });

  it('returns JSON 401 without an Authorization header', async () => {
    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/message:stream', payload: validPayload });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/json');
  });

  it('returns JSON 403 with insufficient scope', async () => {
    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/message:stream', headers: readOnlyHeader, payload: validPayload });

    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns JSON 409 if a run is already active for the same contextId', async () => {
    runRegistry.register('existing-run', { bot: 'bot-a', channelId: 'fixed-card-1', status: 'in_progress' });

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/message:stream', headers: fullAccessHeader, payload: validPayload });

    expect(response.statusCode).toBe(409);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ error: 'Task already in progress for this contextId' });
  });

  it('returns JSON 403 when the API key cannot access the requested agent', async () => {
    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/message:stream', headers: limitedAgentHeader, payload: validPayload });

    expect(response.statusCode).toBe(403);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ error: 'Not authorized for this agent' });
  });

  it('replaces the registry emitter with a no-op on client disconnect', async () => {
    const responsePromise = app.inject({ method: 'POST', url: '/agents/bot-a/message:stream', headers: fullAccessHeader, payload: validPayload });

    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    capturedRequestRaw?.emit('close');
    await responsePromise;

    const emitter = runRegistry.getEmitter('fixed-card-1');
    expect(emitter).toEqual(expect.any(Function));
    expect(emitter?.(sdkEvent('bridge.permission_request', { toolName: 'bash' }))).toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
