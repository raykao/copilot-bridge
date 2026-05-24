import { describe, it, expect, vi, beforeEach } from 'vitest';
import { A2AServer } from './server.js';
import { TaskState, type A2APlatformConfig, type AgentCard } from '../../types.js';
import type { CopilotBridge } from '../../core/bridge.js';
import type { Hono } from 'hono';

type MockSessionEvent = { type: string; data?: Record<string, unknown> };
type MockSessionHandler = (event: MockSessionEvent) => void | Promise<void>;

interface RoutingHarnessOptions {
  event?: MockSessionEvent;
  sendError?: Error;
  manualEvent?: boolean;
  throwAfterEvent?: boolean;
  allowedAgents?: string[];
}

interface RoutingHarness {
  server: A2AServer;
  app: Hono;
  sentPrompts: string[];
  emitEvent: (event?: MockSessionEvent) => Promise<void>;
}

async function rpc(app: Hono, method: string, params: unknown, id: number | string = 1): Promise<{ status: number; body: any }> {
  const res = await app.request('/agents/copilot', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const body = await res.json() as any;
  return { status: res.status, body };
}

async function rpcSse(app: Hono, method: string, params: unknown, id: number | string = 1): Promise<{ status: number; contentType: string | null; events: any[] }> {
  const res = await app.request('/agents/copilot', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-secret',
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  const events = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter((data) => data.length > 0)
    .map((data) => JSON.parse(data) as any);

  return { status: res.status, contentType: res.headers.get('content-type'), events };
}

function messageParams(text = 'hello', configuration?: { returnImmediately?: boolean; taskId?: string }): {
  message: { role: 'user'; parts: Array<{ kind: 'text'; text: string }> };
  configuration?: { returnImmediately?: boolean; taskId?: string };
} {
  return {
    message: { role: 'user', parts: [{ kind: 'text', text }] },
    ...(configuration ? { configuration } : {}),
  };
}

function setupHarness(options: RoutingHarnessOptions = {}): RoutingHarness {
  const defaultEvent = options.event ?? { type: 'session.idle' };
  const sentPrompts: string[] = [];
  const listeners: MockSessionHandler[] = [];
  const emitEvent = async (eventToEmit: MockSessionEvent = defaultEvent): Promise<void> => {
    for (const listener of [...listeners]) {
      await listener(eventToEmit);
    }
  };
  const session = {
    sessionId: 'session-1',
    send: async (input: { prompt: string }): Promise<string> => {
      if (options.sendError) {
        throw options.sendError;
      }
      sentPrompts.push(input.prompt);
      if (!options.manualEvent) {
        await emitEvent(defaultEvent);
      }
      if (options.throwAfterEvent) {
        throw options.sendError ?? new Error('Send failed after terminal event');
      }
      return 'message-1';
    },
    on: (handler: MockSessionHandler): (() => void) => {
      listeners.push(handler);
      return () => {
        const index = listeners.indexOf(handler);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
      };
    },
  };
  const bridge = {
    createSession: vi.fn(async () => session),
    resumeSession: vi.fn(async () => session),
  } as unknown as CopilotBridge;
  const config: A2APlatformConfig = {
    enabled: true,
    port: 0,
    bots: { copilot: { token: 'bot-tok', agent: 'copilot', model: 'test-model' } },
    apiKeys: { 'dev-key': { secret: 'test-secret', allowedAgents: options.allowedAgents ?? ['*'] } },
  };
  const server = new A2AServer(config, bridge);

  return { server, app: server.getApp(), sentPrompts, emitEvent };
}

describe('A2A wire protocol: JSON-RPC 2.0 envelope', () => {
  let app: Hono;

  beforeEach(() => {
    ({ app } = setupHarness());
  });

  it('GetTask with unknown id returns JSON-RPC error envelope', async () => {
    const { status, body } = await rpc(app, 'GetTask', { id: 'no-such-task' });

    expect(status).toBe(200);
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.error).toBeDefined();
    expect(typeof body.error.code).toBe('number');
    expect(typeof body.error.message).toBe('string');
    expect(body.result).toBeUndefined();
  });

  it('GetTask returns result.task shape on known task', async () => {
    const send = await rpc(app, 'SendMessage', messageParams('create task', { returnImmediately: true }));
    const taskId = send.body.result.task.id as string;
    const { body } = await rpc(app, 'GetTask', { id: taskId });

    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.task).toBeDefined();
    expect(typeof body.result.task.id).toBe('string');
    expect(typeof body.result.task.status.state).toBe('string');
    expect(body.error).toBeUndefined();
  });

  it('ListTasks returns array result (not wrapped in task)', async () => {
    const { body } = await rpc(app, 'ListTasks', {});

    expect(body.result).toBeTypeOf('object');
    expect(Array.isArray(body.result.tasks)).toBe(true);
    expect(body.result.task).toBeUndefined();
  });

  it('CancelTask returns TASK_NOT_FOUND error for unknown id', async () => {
    const { body } = await rpc(app, 'CancelTask', { id: 'ghost-task' });

    expect(body.error.code).toBe(-32001);
    expect(body.result).toBeUndefined();
  });

  it('CancelTask on a completed task returns TASK_NOT_CANCELABLE', async () => {
    vi.useFakeTimers();
    try {
      const { app: fastApp, sentPrompts } = setupHarness();
      const sendPromise = rpc(fastApp, 'SendMessage', messageParams('complete task', { returnImmediately: false }));

      await vi.waitFor(() => expect(sentPrompts).toEqual(['complete task']));
      await vi.advanceTimersByTimeAsync(2_000);
      const send = await sendPromise;
      const taskId = send.body.result.task.id as string;
      const { body } = await rpc(fastApp, 'CancelTask', { id: taskId });

      expect(body.error.code).toBe(-32002);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CancelTask on a working task returns result.task with CANCELED state', async () => {
    const { app: manualApp } = setupHarness({ manualEvent: true });
    const send = await rpc(manualApp, 'SendMessage', messageParams('working task', { returnImmediately: true }));
    const taskId = send.body.result.task.id as string;
    const { body } = await rpc(manualApp, 'CancelTask', { id: taskId });

    expect(body.result.task.status.state).toBe(TaskState.CANCELED);
    expect(body.error).toBeUndefined();
  });

  it('Unknown method returns METHOD_NOT_FOUND', async () => {
    const { body } = await rpc(app, 'tasks/unknown', {});

    expect(body.error.code).toBe(-32601);
  });

  it('Invalid JSON body returns PARSE_ERROR', async () => {
    const res = await app.request('/agents/copilot', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-secret',
        'Content-Type': 'application/json',
      },
      body: 'not-json',
    });
    const body = await res.json() as any;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe(-32700);
  });

  it('Missing jsonrpc field returns INVALID_REQUEST', async () => {
    const res = await app.request('/agents/copilot', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id: 1, method: 'GetTask', params: {} }),
    });
    const body = await res.json() as any;

    expect(res.status).toBe(400);
    expect(body.error.code).toBe(-32600);
  });
});

describe('A2A wire protocol: SSE streaming envelopes', () => {
  let app: Hono;

  beforeEach(() => {
    ({ app } = setupHarness());
  });

  it('SendStreamingMessage SSE events are JSON-RPC 2.0 envelopes', async () => {
    const { status, contentType, events } = await rpcSse(app, 'SendStreamingMessage', messageParams('stream hello'), 'stream-1');

    expect(status).toBe(200);
    expect(contentType).toContain('text/event-stream');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.jsonrpc === '2.0')).toBe(true);
    expect(events.every((event) => event.id === 'stream-1')).toBe(true);
    expect(events.every((event) => event.result)).toBe(true);
    expect(events[0].result.task).toBeDefined();
    expect(events.some((event) => event.result.statusUpdate?.final === true)).toBe(true);
  });

  it('SubscribeToTask SSE initial event is JSON-RPC 2.0 envelope', async () => {
    vi.useFakeTimers();
    try {
      const { app: fastApp, sentPrompts } = setupHarness();
      const send = await rpc(fastApp, 'SendMessage', messageParams('subscribe task', { returnImmediately: true }));
      const taskId = send.body.result.task.id as string;
      const ssePromise = rpcSse(fastApp, 'SubscribeToTask', { id: taskId }, 'subscribe-1');

      await vi.waitFor(() => expect(sentPrompts).toEqual(['subscribe task']));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);
      const { status, events } = await ssePromise;

      expect(status).toBe(200);
      expect(events[0].jsonrpc).toBe('2.0');
      expect(events[0].id).toBe('subscribe-1');
      expect(events[0].result.task).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('A2A wire protocol: auth and routing', () => {
  let app: Hono;

  beforeEach(() => {
    ({ app } = setupHarness());
  });

  it('POST /agents/:name without auth returns 401', async () => {
    const res = await app.request('/agents/copilot', { method: 'POST' });

    expect(res.status).toBe(401);
  });

  it('POST /agents/:name for unknown agent returns 403', async () => {
    const { app: restrictedApp } = setupHarness({ allowedAgents: ['copilot'] });
    const res = await restrictedApp.request('/agents/unknown', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'task-1' } }),
    });

    expect(res.status).toBe(403);
  });

  it('GET /agents/copilot/.well-known/agent-card.json conforms to AgentCard shape', async () => {
    const res = await app.request('/agents/copilot/.well-known/agent-card.json');
    const body = await res.json() as AgentCard;

    expect(res.status).toBe(200);
    expect(body.name).toBe('copilot');
    expect(typeof body.url).toBe('string');
    expect(body.url).toContain('copilot');
    expect(body.capabilities.streaming).toBe(true);
    expect(typeof body.version).toBe('string');
  });
});
