import { describe, it, expect } from 'vitest';
import { RpcHandler, RpcErrors, rpcError } from './rpc-handler.js';
import type { RpcContext } from './rpc-handler.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../../types.js';
import { TaskStore } from './task-store.js';

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

  it('rpcError includes correct code and id', () => {
    const resp = rpcError(99, RpcErrors.INTERNAL_ERROR) as any;

    expect(resp.id).toBe(99);
    expect(resp.error.code).toBe(-32603);
  });
});
