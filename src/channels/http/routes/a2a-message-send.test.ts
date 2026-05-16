import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import type { PendingPermissionStore } from '../pending-permission-store.js';
import type { PermissionStore } from '../permission-store.js';
import { RunRegistry, type RunEntry } from '../run-registry.js';
import { registerA2AMessageSendRoute, type A2AMessageSendRouteDeps } from './a2a-message-send.js';

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

const makeRunEntry = (overrides: Partial<RunEntry> = {}): RunEntry => ({
  runId: 'mock-session-id',
  bot: 'bot-a',
  channelId: 'fixed-card-1',
  status: 'created',
  createdAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

describe('registerA2AMessageSendRoute', () => {
  let app: FastifyInstance;
  let deps: A2AMessageSendRouteDeps;
  let dispatchInboundMessage: ReturnType<typeof vi.fn>;
  let registerRun: ReturnType<typeof vi.fn>;
  let getNonTerminalActiveRun: ReturnType<typeof vi.fn>;
  let getEmitter: ReturnType<typeof vi.fn>;
  let updateStatus: ReturnType<typeof vi.fn>;
  let createSessionWithPermissions: ReturnType<typeof vi.fn>;
  let checkPermission: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatchInboundMessage = vi.fn();
    registerRun = vi.fn((runId: string, entry: Omit<RunEntry, 'runId' | 'createdAt'>) => makeRunEntry({
      ...entry,
      runId,
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    getNonTerminalActiveRun = vi.fn().mockReturnValue(undefined);
    getEmitter = vi.fn();
    updateStatus = vi.fn().mockReturnValue(true);
    createSessionWithPermissions = vi.fn(async (channelId: string) => ({ sessionId: channelId }));
    checkPermission = vi.fn().mockResolvedValue(null);
    deps = {
      adapter: { dispatchInboundMessage } as Partial<A2AMessageSendRouteDeps['adapter']> as A2AMessageSendRouteDeps['adapter'],
      bots: testBots,
      runRegistry: {
        register: registerRun,
        getNonTerminalActiveRun,
        getEmitter,
        updateStatus,
      } as Partial<RunRegistry> as RunRegistry,
      permissionStore: {
        shouldApprove: vi.fn(),
        shouldDeny: vi.fn().mockReturnValue(false),
      } as unknown as PermissionStore,
      pendingPermissionStore: { park: vi.fn() } as unknown as PendingPermissionStore,
      checkPermission,
      createSessionWithPermissions,
    };

    app = Fastify({ logger: false });
    registerAuthHook(app, authConfig);
    registerA2AMessageSendRoute(app, deps);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 200 with a Task object for a valid message:send request', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: validPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 'fixed-card-1',
      contextId: 'fixed-card-1',
      kind: 'task',
      status: {
        state: 'submitted',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    });
  });

  it('returns a non-empty Task id, request contextId, and kind task', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: validPayload,
    });
    const task = response.json();

    expect(task.kind).toBe('task');
    expect(task.id).toEqual(expect.any(String));
    expect(task.id.length).toBeGreaterThan(0);
    expect(task.contextId).toBe('fixed-card-1');
  });

  it('returns submitted state immediately after creation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: validPayload,
    });

    expect(response.json().status.state).toBe('submitted');
  });

  it('generates and returns a UUID-like contextId when message.contextId is omitted', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: {
        message: {
          role: 'user',
          parts: [{ kind: 'text', text: 'hello' }],
          messageId: 'message-1',
        },
      },
    });
    const task = response.json();

    expect(response.statusCode).toBe(200);
    expect(task.contextId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(task.id).toBe(task.contextId);
  });

  it('uses message.contextId as Task contextId and run channelId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: validPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().contextId).toBe('fixed-card-1');
    expect(registerRun).toHaveBeenCalledWith('fixed-card-1', {
      bot: 'bot-a',
      channelId: 'fixed-card-1',
      status: 'created',
    });
  });

  it('dispatches exactly one inbound message with joined text parts and context channelId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: {
        message: {
          role: 'user',
          parts: [
            { kind: 'text', text: 'hello ' },
            { kind: 'text', text: 'world' },
          ],
          messageId: 'message-1',
          contextId: 'fixed-card-1',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
    expect(dispatchInboundMessage).toHaveBeenCalledWith({
      platform: 'http',
      channelId: 'fixed-card-1',
      userId: 'full-access',
      username: 'full-access',
      text: 'hello world',
      postId: 'fixed-card-1',
      mentionsBot: true,
      isDM: false,
    });
  });

  it('returns 400 if message is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Missing required field: message' });
  });

  it('returns 400 if message.role is not user', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: { message: { ...validPayload.message, role: 'agent' } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'message.role must be "user"' });
  });

  it('returns 400 if message.messageId is missing or empty', async () => {
    const missingResponse = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: { message: { role: 'user', parts: [{ kind: 'text', text: 'hello' }], contextId: 'fixed-card-1' } },
    });
    const emptyResponse = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: { message: { ...validPayload.message, messageId: '' } },
    });

    expect(missingResponse.statusCode).toBe(400);
    expect(emptyResponse.statusCode).toBe(400);
    expect(missingResponse.json()).toEqual({ error: 'Missing required field: message.messageId' });
    expect(emptyResponse.json()).toEqual({ error: 'Missing required field: message.messageId' });
  });

  it('returns 400 if message.parts is missing or empty', async () => {
    const missingResponse = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: { message: { role: 'user', messageId: 'message-1', contextId: 'fixed-card-1' } },
    });
    const emptyResponse = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: { message: { ...validPayload.message, parts: [] } },
    });

    expect(missingResponse.statusCode).toBe(400);
    expect(emptyResponse.statusCode).toBe(400);
    expect(missingResponse.json()).toEqual({ error: 'Missing required field: message.parts' });
    expect(emptyResponse.json()).toEqual({ error: 'Missing required field: message.parts' });
  });

  it('returns 400 if any part is not a text part', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: { message: { ...validPayload.message, parts: [{ kind: 'file', file: {} }] } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Only text parts are supported in Phase B' });
  });

  it('returns 400 if a text part has empty text', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: { message: { ...validPayload.message, parts: [{ kind: 'text', text: '' }] } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Each text part must have a non-empty text field' });
  });

  it('returns 401 with no Authorization header', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      payload: validPayload,
    });

    expect(response.statusCode).toBe(401);
  });

  it('returns 403 if api key lacks agent:execute', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: readOnlyHeader,
      payload: validPayload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 403 if api key cannot access the requested agent', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: limitedAgentHeader,
      payload: validPayload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Not authorized for this agent' });
  });

  it('returns 404 if the agent name does not exist in deps.bots', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/missing-bot/message:send',
      headers: fullAccessHeader,
      payload: validPayload,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Agent not found' });
  });

  it('returns 409 if a non-terminal run already exists for the same contextId', async () => {
    getNonTerminalActiveRun.mockReturnValue(makeRunEntry({ status: 'in_progress' }));

    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/message:send',
      headers: fullAccessHeader,
      payload: validPayload,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Task already in progress for this contextId' });
    expect(createSessionWithPermissions).not.toHaveBeenCalled();
    expect(registerRun).not.toHaveBeenCalled();
    expect(dispatchInboundMessage).not.toHaveBeenCalled();
  });
});
