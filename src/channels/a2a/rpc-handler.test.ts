import { describe, it, expect } from 'vitest';
import { RpcHandler, RpcErrors, rpcError } from './rpc-handler.js';
import type { RpcContext } from './rpc-handler.js';
import { TaskState, type A2APlatformConfig, type JsonRpcRequest, type JsonRpcResponse, type Task } from '../../types.js';
import type { CopilotBridge } from '../../core/bridge.js';
import { TaskStore } from './task-store.js';
import { SessionMap } from './session-map.js';

type MockSessionEvent = { type: 'session.idle' | 'session.error'; data?: { message?: string; content?: string } };
type MockSessionHandler = (event: MockSessionEvent) => void;
interface RoutingHarnessOptions {
  event?: MockSessionEvent;
  sendError?: Error;
}

function buildRoutingHarness(options: RoutingHarnessOptions = {}): {
  handler: RpcHandler;
  sentPrompts: string[];
} {
  const event = options.event ?? { type: 'session.idle' };
  const store = new TaskStore();
  const sessionMap = new SessionMap();
  const sentPrompts: string[] = [];
  const listeners: MockSessionHandler[] = [];
  const session = {
    sessionId: 'session-1',
    send: async (input: { prompt: string }): Promise<string> => {
      if (options.sendError) {
        throw options.sendError;
      }
      sentPrompts.push(input.prompt);
      for (const listener of listeners) {
        listener(event);
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

  return { handler: new RpcHandler(store, sessionMap, bridge, config), sentPrompts };
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

  it('rpcError includes correct code and id', () => {
    const resp = rpcError(99, RpcErrors.INTERNAL_ERROR) as any;

    expect(resp.id).toBe(99);
    expect(resp.error.code).toBe(-32603);
  });
});
