import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerAuthHook, type AuthConfig } from '../auth.js';
import { PushNotificationStore } from '../push-notification-store.js';
import { RunRegistry, type RunStatus } from '../run-registry.js';
import { registerA2APushNotificationRoutes, type A2APushNotificationRouteDeps } from './a2a-push-notification.js';

const fullAccessHeader = { authorization: 'Bearer test-secret-full' };
const readOnlyHeader = { authorization: 'Bearer test-secret-readonly' };

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
  ]),
};

const testBots = {
  'bot-a': {},
  'bot-b': {},
};

const setPayload = {
  taskId: 'task-1',
  pushNotificationConfig: {
    url: 'https://kanban.example/api/internal/push-callback',
    token: 'push-token',
  },
};

describe('registerA2APushNotificationRoutes', () => {
  let app: FastifyInstance;
  let deps: A2APushNotificationRouteDeps;
  let runRegistry: RunRegistry;
  let pushNotificationStore: PushNotificationStore;
  let onConfigSet: ReturnType<typeof vi.fn>;
  let onConfigDeleted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    runRegistry = new RunRegistry();
    pushNotificationStore = new PushNotificationStore();
    onConfigSet = vi.fn();
    onConfigDeleted = vi.fn();
    deps = {
      bots: testBots,
      runRegistry,
      pushNotificationStore,
      onConfigSet,
      onConfigDeleted,
    };

    app = Fastify({ logger: false });
    registerAuthHook(app, authConfig);
    registerA2APushNotificationRoutes(app, deps);
  });

  afterEach(async () => {
    await app.close();
  });

  function registerTask(status: RunStatus, overrides: { runId?: string; bot?: string; channelId?: string } = {}) {
    const entry = runRegistry.register(overrides.runId ?? 'task-1', {
      bot: overrides.bot ?? 'bot-a',
      channelId: overrides.channelId ?? 'ctx-1',
      status,
    });
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      runRegistry.updateStatus(entry.runId, status, { finishedAt: '2026-01-01T00:00:00.000Z' });
    }
    return runRegistry.get(entry.runId)!;
  }

  it('set stores push notification config for a non-terminal task', async () => {
    registerTask('in_progress');

    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/tasks:pushNotificationConfig:set',
      headers: fullAccessHeader,
      payload: setPayload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      taskId: 'task-1',
      pushNotificationConfig: {
        url: 'https://kanban.example/api/internal/push-callback',
        token: 'push-token',
      },
    });
    expect(pushNotificationStore.get('task-1')).toMatchObject({
      taskId: 'task-1',
      contextId: 'ctx-1',
      url: 'https://kanban.example/api/internal/push-callback',
      token: 'push-token',
    });
    expect(onConfigSet).toHaveBeenCalledWith('task-1');
  });

  it('set returns 400 when the URL is not http(s)', async () => {
    registerTask('in_progress');

    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/tasks:pushNotificationConfig:set',
      headers: fullAccessHeader,
      payload: { ...setPayload, pushNotificationConfig: { ...setPayload.pushNotificationConfig, url: 'ftp://kanban.example/hook' } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'pushNotificationConfig.url must be an http(s) URL' });
    expect(pushNotificationStore.all()).toEqual([]);
  });

  it('set returns 400 when token is missing', async () => {
    registerTask('in_progress');

    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/tasks:pushNotificationConfig:set',
      headers: fullAccessHeader,
      payload: { taskId: 'task-1', pushNotificationConfig: { url: 'https://kanban.example/hook' } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Missing required field: pushNotificationConfig.token' });
    expect(pushNotificationStore.all()).toEqual([]);
  });

  it('set returns 404 when the task does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/tasks:pushNotificationConfig:set',
      headers: fullAccessHeader,
      payload: setPayload,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Task not found' });
  });

  it('set returns 404 when the task belongs to a different agent', async () => {
    registerTask('in_progress', { bot: 'bot-a' });

    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-b/tasks:pushNotificationConfig:set',
      headers: fullAccessHeader,
      payload: setPayload,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Task not found' });
  });

  it('set returns 409 when the task is terminal', async () => {
    registerTask('completed');

    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/tasks:pushNotificationConfig:set',
      headers: fullAccessHeader,
      payload: setPayload,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'Task is in terminal state' });
    expect(pushNotificationStore.all()).toEqual([]);
  });

  it('set requires agent:execute', async () => {
    registerTask('in_progress');

    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/tasks:pushNotificationConfig:set',
      headers: readOnlyHeader,
      payload: setPayload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: 'Forbidden' });
  });

  it('delete removes an existing push notification config', async () => {
    registerTask('in_progress');
    pushNotificationStore.set({ taskId: 'task-1', contextId: 'ctx-1', url: 'https://kanban.example/hook', token: 'push-token' });

    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/tasks:pushNotificationConfig:delete',
      headers: fullAccessHeader,
      payload: { id: 'task-1' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({});
    expect(pushNotificationStore.get('task-1')).toBeUndefined();
    expect(onConfigDeleted).toHaveBeenCalledWith('task-1');
  });

  it('delete returns 404 when the task does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/tasks:pushNotificationConfig:delete',
      headers: fullAccessHeader,
      payload: { id: 'missing' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Task not found' });
  });

  it('delete returns 404 after the config has already been deleted', async () => {
    registerTask('in_progress');
    pushNotificationStore.set({ taskId: 'task-1', contextId: 'ctx-1', url: 'https://kanban.example/hook', token: 'push-token' });

    const first = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/tasks:pushNotificationConfig:delete',
      headers: fullAccessHeader,
      payload: { id: 'task-1' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/agents/bot-a/tasks:pushNotificationConfig:delete',
      headers: fullAccessHeader,
      payload: { id: 'task-1' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(404);
    expect(second.json()).toEqual({ error: 'Task not found' });
    expect(onConfigDeleted).toHaveBeenCalledTimes(2);
  });
});
