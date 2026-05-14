import type { SessionEvent } from '@github/copilot-sdk';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import { RunRegistry, type RunStatus } from '../run-registry.js';
import { registerA2ATasksRoutes, type A2ATasksRouteDeps } from './a2a-tasks.js';

const fullAccessHeader = { authorization: 'Bearer test-secret-full' };
const readOnlyHeader = { authorization: 'Bearer test-secret-readonly' };
const executeOnlyHeader = { authorization: 'Bearer test-secret-execute' };
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
    ['execute-only', {
      secret: 'test-secret-execute',
      allowedAgents: ['bot-a'],
      allowedOps: ['agent:execute'],
    }],
    ['limited-agent', {
      secret: 'test-secret-limited',
      allowedAgents: ['bot-b'],
      allowedOps: ['agent:read', 'agent:execute'],
    }],
  ]),
};

const testBots = {
  'bot-a': {},
  'bot-b': {},
};

type SseFrame = { event: string; data: any };

const sdkEvent = (type: string, data: Record<string, unknown> = {}): SessionEvent => ({
  type,
  data,
  id: `${type}-id`,
  timestamp: '2026-01-01T00:00:00.000Z',
  parentId: null,
} as unknown as SessionEvent);

const parseSseFrames = (body: string): SseFrame[] => body.trim().split('\n\n').filter(Boolean).map((frame) => {
  const lines = frame.split('\n');
  const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length) ?? '';
  const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length) ?? '{}';
  return { event, data: JSON.parse(data) };
});

describe('registerA2ATasksRoutes', () => {
  let app: FastifyInstance;
  let deps: A2ATasksRouteDeps;
  let runRegistry: RunRegistry;
  let abortSession: ReturnType<typeof vi.fn>;
  let getSession: ReturnType<typeof vi.fn>;
  let subscribeToSessionEvents: ReturnType<typeof vi.fn>;
  let unsubscribe: ReturnType<typeof vi.fn>;
  let capturedHandler: ((sessionId: string, channelId: string, event: any) => void) | undefined;

  beforeEach(() => {
    runRegistry = new RunRegistry();
    abortSession = vi.fn().mockResolvedValue(undefined);
    getSession = vi.fn().mockReturnValue(undefined);
    unsubscribe = vi.fn();
    capturedHandler = undefined;
    subscribeToSessionEvents = vi.fn((_channelId, handler) => {
      capturedHandler = handler;
      return unsubscribe;
    });
    deps = {
      bots: testBots,
      runRegistry,
      subscribeToSessionEvents,
      getSession,
      abortSession,
    };

    app = Fastify({ logger: false });
    registerAuthHook(app, authConfig);
    registerA2ATasksRoutes(app, deps);
  });

  afterEach(async () => {
    await app.close();
  });

  function registerTask(status: RunStatus, overrides: { runId?: string; bot?: string; channelId?: string; error?: string } = {}) {
    const entry = runRegistry.register(overrides.runId ?? 'task-1', {
      bot: overrides.bot ?? 'bot-a',
      channelId: overrides.channelId ?? 'ctx-1',
      status,
    });
    if (overrides.error || status === 'completed' || status === 'failed' || status === 'cancelled') {
      runRegistry.updateStatus(entry.runId, status, {
        finishedAt: '2026-01-01T00:00:00.000Z',
        error: overrides.error,
      });
    }
    return runRegistry.get(entry.runId)!;
  }

  it('tasks:get returns working for an in-progress run', async () => {
    registerTask('in_progress');

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:get', headers: readOnlyHeader, payload: { id: 'task-1' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'task-1', contextId: 'ctx-1', kind: 'task', status: { state: 'working' } });
  });

  it('tasks:get returns completed for a completed run', async () => {
    registerTask('completed');

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:get', headers: readOnlyHeader, payload: { id: 'task-1' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: { state: 'completed', timestamp: '2026-01-01T00:00:00.000Z' } });
  });

  it('tasks:get returns failed with an error message for a failed run', async () => {
    registerTask('failed', { error: 'boom' });

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:get', headers: readOnlyHeader, payload: { id: 'task-1' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: { state: 'failed', message: { parts: [{ kind: 'text', text: 'boom' }] } } });
  });

  it('tasks:get returns input-required for an awaiting run', async () => {
    registerTask('awaiting');

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:get', headers: readOnlyHeader, payload: { id: 'task-1' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: { state: 'input-required' } });
  });

  it('tasks:get returns 400 if id is missing or empty', async () => {
    const missing = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:get', headers: readOnlyHeader, payload: {} });
    const empty = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:get', headers: readOnlyHeader, payload: { id: '' } });

    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: 'Missing required field: id' });
    expect(empty.statusCode).toBe(400);
    expect(empty.json()).toEqual({ error: 'Missing required field: id' });
  });

  it('tasks:get returns 404 if the task id does not exist', async () => {
    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:get', headers: readOnlyHeader, payload: { id: 'missing' } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Task not found' });
  });

  it('tasks:get returns 404 if the task bot does not match the URL agent', async () => {
    registerTask('in_progress', { bot: 'bot-a' });

    const response = await app.inject({ method: 'POST', url: '/agents/bot-b/tasks:get', headers: fullAccessHeader, payload: { id: 'task-1' } });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Task not found' });
  });

  it('tasks:get returns 401 with no Authorization header', async () => {
    registerTask('in_progress');

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:get', payload: { id: 'task-1' } });

    expect(response.statusCode).toBe(401);
  });

  it('tasks:get returns 403 if the api key lacks agent:read', async () => {
    registerTask('in_progress');

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:get', headers: executeOnlyHeader, payload: { id: 'task-1' } });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
  });

  it('tasks:get returns 403 if the api key cannot access the requested agent', async () => {
    registerTask('in_progress');

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:get', headers: limitedAgentHeader, payload: { id: 'task-1' } });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Not authorized for this agent' });
  });

  it('tasks:cancel cancels an in-progress run and returns a canceled Task with timestamp', async () => {
    registerTask('in_progress');

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:cancel', headers: fullAccessHeader, payload: { id: 'task-1' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'task-1', contextId: 'ctx-1', kind: 'task', status: { state: 'canceled', timestamp: expect.any(String) } });
    expect(runRegistry.get('task-1')?.status).toBe('cancelled');
  });

  it('tasks:cancel calls abortSession exactly once for an in-progress run', async () => {
    registerTask('in_progress');

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:cancel', headers: fullAccessHeader, payload: { id: 'task-1' } });

    expect(response.statusCode).toBe(200);
    expect(abortSession).toHaveBeenCalledTimes(1);
    expect(abortSession).toHaveBeenCalledWith('task-1');
  });

  it('tasks:cancel returns an already-terminal task without updating status or aborting', async () => {
    registerTask('completed');
    const updateStatus = vi.spyOn(runRegistry, 'updateStatus');

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:cancel', headers: fullAccessHeader, payload: { id: 'task-1' } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: { state: 'completed' } });
    expect(runRegistry.get('task-1')?.status).toBe('completed');
    expect(updateStatus).not.toHaveBeenCalled();
    expect(abortSession).not.toHaveBeenCalled();
  });

  it('tasks:cancel requires agent:execute rather than agent:read', async () => {
    registerTask('in_progress');

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:cancel', headers: readOnlyHeader, payload: { id: 'task-1' } });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
    expect(runRegistry.get('task-1')?.status).toBe('in_progress');
  });

  it('tasks:resubscribe returns text/event-stream for an in-progress task', async () => {
    registerTask('in_progress');

    const responsePromise = app.inject({ method: 'POST', url: '/agents/bot-a/tasks:resubscribe', headers: readOnlyHeader, payload: { id: 'task-1' } });
    await vi.waitFor(() => expect(capturedHandler).toBeDefined());
    capturedHandler?.('task-1', 'ctx-1', sdkEvent('session.idle'));
    const response = await responsePromise;

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
  });

  it('tasks:resubscribe replays terminal completed events and a synthetic terminal status update', async () => {
    registerTask('completed');
    getSession.mockReturnValue({ getMessages: vi.fn().mockResolvedValue([sdkEvent('assistant.message', { content: 'done' }), sdkEvent('session.idle')]) });

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:resubscribe', headers: readOnlyHeader, payload: { id: 'task-1' } });
    const frames = parseSseFrames(response.body);

    expect(response.statusCode).toBe(200);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ event: 'artifact-update', data: { artifact: { parts: [{ kind: 'text', text: 'done' }] } } });
    expect(frames[1]).toMatchObject({ event: 'status-update', data: { status: { state: 'completed' }, final: true } });
  });

  it('tasks:resubscribe emits failed synthetic terminal status for a failed task', async () => {
    registerTask('failed', { error: 'boom' });
    getSession.mockReturnValue({ getMessages: vi.fn().mockResolvedValue([]) });

    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:resubscribe', headers: readOnlyHeader, payload: { id: 'task-1' } });
    const frames = parseSseFrames(response.body);

    expect(response.statusCode).toBe(200);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ event: 'status-update', data: { status: { state: 'failed' }, final: true } });
  });

  it('tasks:resubscribe returns 404 for a missing task before writing SSE headers', async () => {
    const response = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:resubscribe', headers: readOnlyHeader, payload: { id: 'missing' } });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ error: 'Task not found' });
  });

  it('tasks:resubscribe auth failures return JSON rather than SSE', async () => {
    registerTask('in_progress');

    const missingAuth = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:resubscribe', payload: { id: 'task-1' } });
    const forbidden = await app.inject({ method: 'POST', url: '/agents/bot-a/tasks:resubscribe', headers: executeOnlyHeader, payload: { id: 'task-1' } });

    expect(missingAuth.statusCode).toBe(401);
    expect(missingAuth.headers['content-type']).toContain('application/json');
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.headers['content-type']).toContain('application/json');
  });
});
