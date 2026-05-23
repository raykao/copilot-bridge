import { describe, it, expect } from 'vitest';
import { RpcHandler, RpcErrors, rpcError } from './rpc-handler.js';
import type { RpcContext } from './rpc-handler.js';
import { TaskState, type A2APlatformConfig, type JsonRpcRequest, type JsonRpcResponse, type Task } from '../../types.js';
import type { CopilotBridge } from '../../core/bridge.js';
import { TaskStore } from './task-store.js';
import { SessionMap } from './session-map.js';

type MockSessionEvent = { type: string; data?: Record<string, unknown> };
type MockSessionHandler = (event: MockSessionEvent) => void | Promise<void>;
interface RoutingHarnessOptions {
  event?: MockSessionEvent;
  sendError?: Error;
  manualEvent?: boolean;
  throwAfterEvent?: boolean;
}

function waitForAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createMockSseStream(): {
  stream: any;
  events: any[];
  writes: string[];
  closed: boolean;
} {
  const events: any[] = [];
  const writes: string[] = [];
  const state = { closed: false };
  return {
    stream: {
      writeSSE: async (event: any): Promise<void> => {
        events.push(event);
      },
      write: async (chunk: string): Promise<void> => {
        writes.push(chunk);
      },
      close: async (): Promise<void> => {
        state.closed = true;
      },
    },
    events,
    writes,
    get closed() {
      return state.closed;
    },
  };
}

function parseSseEventData(sse: { events: Array<{ data: string }> }): any[] {
  return sse.events.map((event) => JSON.parse(event.data));
}

function terminalStatusUpdates(sse: { events: Array<{ data: string }> }): any[] {
  return parseSseEventData(sse)
    .map((event) => event.statusUpdate)
    .filter((statusUpdate) => statusUpdate?.final === true);
}

function buildRoutingHarness(options: RoutingHarnessOptions = {}): {
  handler: RpcHandler;
  sentPrompts: string[];
  emitEvent: (event?: MockSessionEvent) => Promise<void>;
} {
  const event = options.event ?? { type: 'session.idle' };
  const store = new TaskStore();
  const sessionMap = new SessionMap();
  const sentPrompts: string[] = [];
  const listeners: MockSessionHandler[] = [];
  const emitEvent = async (eventToEmit: MockSessionEvent = event): Promise<void> => {
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
        await emitEvent();
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
    createSession: async () => session,
    resumeSession: async () => session,
  } as unknown as CopilotBridge;
  const config: A2APlatformConfig = {
    enabled: true,
    bots: { copilot: { token: 'bot-token', agent: 'copilot', model: 'test-model' } },
  };

  return { handler: new RpcHandler(store, sessionMap, bridge, config), sentPrompts, emitEvent };
}

describe('RpcHandler dispatch', () => {
  const ctx: RpcContext = { agentName: 'copilot', allowedAgents: ['*'], isStreaming: false };

  it('returns METHOD_NOT_FOUND for unknown method', async () => {
    const handler = new RpcHandler(new TaskStore());
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'Unknown' };
    const resp = await handler.dispatch(req, ctx);

    expect((resp as any).error?.code).toBe(-32601);
  });

  it('GetTask returns TASK_NOT_FOUND for unknown id', async () => {
    const handler = new RpcHandler(new TaskStore());
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: 'no-such-id' } };
    const resp = await handler.dispatch(req, ctx);

    expect((resp as any).error?.code).toBe(-32001);
  });

  it('GetTask returns task for known id', async () => {
    const store = new TaskStore();
    const task = store.createTask();
    const handler = new RpcHandler(store);
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 3, method: 'GetTask', params: { id: task.id } };
    const resp = await handler.dispatch(req, ctx) as JsonRpcResponse & any;

    expect(resp.result?.id).toBe(task.id);
  });

  it('ListTasks returns all tasks when no filter', async () => {
    const store = new TaskStore();
    store.createTask();
    store.createTask();
    const handler = new RpcHandler(store);
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 4, method: 'ListTasks', params: {} };
    const resp = await handler.dispatch(req, ctx) as JsonRpcResponse & any;

    expect(resp.result?.tasks).toHaveLength(2);
  });

  it('SendMessage creates a task, sends text, and completes on session idle', async () => {
    const { handler, sentPrompts } = buildRoutingHarness();
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 5,
      method: 'SendMessage',
      params: {
        message: {
          role: 'user',
          contextId: 'ctx-1',
          parts: [{ kind: 'text', text: 'hello' }],
        },
      },
    };

    const resp = await handler.dispatch(req, ctx) as JsonRpcResponse & { result: Task };

    expect(resp.result.status.state).toBe(TaskState.COMPLETED);
    expect(resp.result.contextId).toBe('ctx-1');
    expect(sentPrompts).toEqual(['hello']);
  });

  it('SendMessage treats null configuration like omitted configuration', async () => {
    const { handler, sentPrompts } = buildRoutingHarness();
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 6,
      method: 'SendMessage',
      params: {
        message: {
          role: 'user',
          contextId: 'ctx-null-config',
          parts: [{ kind: 'text', text: 'hello null config' }],
        },
        configuration: null,
      },
    };

    const resp = await handler.dispatch(req, ctx) as JsonRpcResponse & { result: Task };

    expect(resp.result.status.state).toBe(TaskState.COMPLETED);
    expect(resp.result.contextId).toBe('ctx-null-config');
    expect(sentPrompts).toEqual(['hello null config']);
  });

  it('SendMessage returns a working task immediately when requested', async () => {
    const { handler, sentPrompts } = buildRoutingHarness();
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 7,
      method: 'SendMessage',
      params: {
        message: { role: 'user', parts: [{ kind: 'text', text: 'fast' }] },
        configuration: { returnImmediately: true },
      },
    };

    const resp = await handler.dispatch(req, ctx) as JsonRpcResponse & { result: Task };

    expect(resp.result.status.state).toBe(TaskState.WORKING);
    expect(sentPrompts).toEqual(['fast']);
  });

  it('SendMessage returns a failed task with Error message text when session send throws', async () => {
    const { handler } = buildRoutingHarness({ sendError: new Error('Connection timeout') });
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 8,
      method: 'SendMessage',
      params: {
        message: { role: 'user', parts: [{ kind: 'text', text: 'will fail' }] },
      },
    };

    const resp = await handler.dispatch(req, ctx) as JsonRpcResponse & { result: Task };
    const statusMessagePart = resp.result.status.message?.parts[0];
    const statusText = statusMessagePart?.kind === 'text' ? statusMessagePart.text : '';

    expect(resp.result.status.state).toBe(TaskState.FAILED);
    expect(statusText).toContain('Connection timeout');
  });

  it('SendMessage returns TASK_NOT_FOUND for unknown continuation task', async () => {
    const { handler } = buildRoutingHarness();
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 9,
      method: 'SendMessage',
      params: {
        message: { role: 'user', parts: [{ kind: 'text', text: 'continue' }] },
        configuration: { taskId: 'missing-task' },
      },
    };

    const resp = await handler.dispatch(req, ctx);

    expect((resp as JsonRpcResponse & { error: { code: number } }).error.code).toBe(-32001);
  });


  it('SubscribeToTask returns SSE when no sseStream provided', async () => {
    const handler = new RpcHandler(new TaskStore());
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 10, method: 'SubscribeToTask', params: { id: 'task-1' } };
    const resp = await handler.dispatch(req, ctx);

    expect(resp).toBe('SSE');
  });

  it('SubscribeToTask closes stream for unknown taskId', async () => {
    const handler = new RpcHandler(new TaskStore());
    const sse = createMockSseStream();
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 11, method: 'SubscribeToTask', params: { id: 'missing-task' } };
    const resp = await handler.dispatch(req, { ...ctx, isStreaming: true, sseStream: sse.stream });

    expect(resp).toBe('SSE');
    expect(sse.closed).toBe(true);
    expect(sse.events).toEqual([]);
  });

  it('SubscribeToTask emits current task and closes immediately for completed task', async () => {
    const store = new TaskStore();
    const task = store.createTask({ status: { state: TaskState.COMPLETED, timestamp: '2026-01-01T00:00:00.000Z' } });
    const handler = new RpcHandler(store);
    const sse = createMockSseStream();
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 12, method: 'SubscribeToTask', params: { id: task.id } };
    const resp = await handler.dispatch(req, { ...ctx, isStreaming: true, sseStream: sse.stream });

    expect(resp).toBe('SSE');
    expect(sse.closed).toBe(true);
    expect(JSON.parse(sse.events[0].data).task.id).toBe(task.id);
  });

  it('SubscribeToTask keeps SSE open until a live terminal update', async () => {
    const store = new TaskStore();
    const task = store.createTask({
      status: { state: TaskState.SUBMITTED, timestamp: '2026-01-01T00:00:00.000Z' },
    });
    const handler = new RpcHandler(store);
    const sse = createMockSseStream();
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: 13, method: 'SubscribeToTask', params: { id: task.id } };
    let settled = false;

    const dispatchPromise = handler.dispatch(req, { ...ctx, isStreaming: true, sseStream: sse.stream }).then((resp) => {
      settled = true;
      return resp;
    });

    await waitForAsyncWork();
    expect(sse.closed).toBe(false);
    expect(settled).toBe(false);
    expect(JSON.parse(sse.events[0].data).task.id).toBe(task.id);

    store.updateTask(task.id, { status: { state: TaskState.WORKING } });
    await waitForAsyncWork();
    const workingUpdate = JSON.parse(sse.events[1].data).statusUpdate;
    expect(workingUpdate.status.state).toBe(TaskState.WORKING);
    expect(workingUpdate.final).toBe(false);
    expect(sse.closed).toBe(false);
    expect(settled).toBe(false);

    store.updateTask(task.id, { status: { state: TaskState.COMPLETED } });
    const resp = await dispatchPromise;
    const completedUpdate = JSON.parse(sse.events[2].data).statusUpdate;
    expect(resp).toBe('SSE');
    expect(completedUpdate.status.state).toBe(TaskState.COMPLETED);
    expect(completedUpdate.final).toBe(true);
    expect(sse.closed).toBe(true);
    expect(settled).toBe(true);
  });

  it('SendStreamingMessage returns SSE when no sseStream provided', async () => {
    const { handler } = buildRoutingHarness();
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 14,
      method: 'SendStreamingMessage',
      params: { message: { role: 'user', parts: [{ kind: 'text', text: 'hello stream' }] } },
    };

    const resp = await handler.dispatch(req, ctx);

    expect(resp).toBe('SSE');
  });

  it('SendStreamingMessage emits SUBMITTED then COMPLETED events via SSE', async () => {
    const { handler, sentPrompts } = buildRoutingHarness();
    const sse = createMockSseStream();
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 15,
      method: 'SendStreamingMessage',
      params: {
        message: {
          role: 'user',
          contextId: 'ctx-stream',
          parts: [{ kind: 'text', text: 'stream hello' }],
        },
      },
    };

    const resp = await handler.dispatch(req, { ...ctx, isStreaming: true, sseStream: sse.stream });

    expect(resp).toBe('SSE');
    expect(sentPrompts).toEqual(['stream hello']);
    expect(sse.closed).toBe(true);
    const submitted = JSON.parse(sse.events[0].data).task as Task;
    const completed = JSON.parse(sse.events[1].data).statusUpdate;
    const terminalUpdates = terminalStatusUpdates(sse);
    expect(submitted.status.state).toBe(TaskState.SUBMITTED);
    expect(submitted.contextId).toBe('ctx-stream');
    expect(completed.taskId).toBe(submitted.id);
    expect(completed.status.state).toBe(TaskState.COMPLETED);
    expect(completed.final).toBe(true);
    expect(terminalUpdates).toHaveLength(1);
  });

  it('SendStreamingMessage preserves completed status when send throws after synchronous terminal event', async () => {
    const { handler, sentPrompts } = buildRoutingHarness({ throwAfterEvent: true });
    const sse = createMockSseStream();
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 16,
      method: 'SendStreamingMessage',
      params: {
        message: {
          role: 'user',
          contextId: 'ctx-stream-throw-after-event',
          parts: [{ kind: 'text', text: 'stream throw after event' }],
        },
      },
    };

    const resp = await handler.dispatch(req, { ...ctx, isStreaming: true, sseStream: sse.stream });

    expect(resp).toBe('SSE');
    expect(sentPrompts).toEqual(['stream throw after event']);
    expect(sse.closed).toBe(true);
    const submitted = JSON.parse(sse.events[0].data).task as Task;
    const terminalUpdates = terminalStatusUpdates(sse);
    expect(submitted.status.state).toBe(TaskState.SUBMITTED);
    expect(terminalUpdates).toHaveLength(1);
    expect(terminalUpdates[0].taskId).toBe(submitted.id);
    expect(terminalUpdates[0].status.state).toBe(TaskState.COMPLETED);
    expect(terminalUpdates[0].final).toBe(true);
  });

  it('SendStreamingMessage keeps dispatch pending until an async terminal event', async () => {
    const { handler, sentPrompts, emitEvent } = buildRoutingHarness({ manualEvent: true });
    const sse = createMockSseStream();
    const req: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: 17,
      method: 'SendStreamingMessage',
      params: {
        message: {
          role: 'user',
          contextId: 'ctx-stream-async',
          parts: [{ kind: 'text', text: 'stream async hello' }],
        },
      },
    };
    let settled = false;

    const dispatchPromise = handler.dispatch(req, { ...ctx, isStreaming: true, sseStream: sse.stream }).then((resp) => {
      settled = true;
      return resp;
    });

    await waitForAsyncWork();
    expect(sentPrompts).toEqual(['stream async hello']);
    expect(sse.closed).toBe(false);
    expect(settled).toBe(false);
    const submitted = JSON.parse(sse.events[0].data).task as Task;
    expect(submitted.status.state).toBe(TaskState.SUBMITTED);
    expect(submitted.contextId).toBe('ctx-stream-async');

    await emitEvent({ type: 'session.idle' });
    const resp = await dispatchPromise;
    const completed = JSON.parse(sse.events[1].data).statusUpdate;
    expect(resp).toBe('SSE');
    expect(completed.taskId).toBe(submitted.id);
    expect(completed.status.state).toBe(TaskState.COMPLETED);
    expect(completed.final).toBe(true);
    expect(sse.closed).toBe(true);
    expect(settled).toBe(true);
  });

  it('rpcError includes correct code and id', () => {
    const resp = rpcError(99, RpcErrors.INTERNAL_ERROR) as any;

    expect(resp.id).toBe(99);
    expect(resp.error.code).toBe(-32603);
  });
});
