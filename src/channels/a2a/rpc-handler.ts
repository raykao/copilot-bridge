import { createLogger } from '../../logger.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../../types.js';
import type { TaskStore } from './task-store.js';

const log = createLogger('a2a:rpc');

export const RpcErrors = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  TASK_NOT_FOUND: { code: -32001, message: 'Task not found' },
  TASK_NOT_CANCELABLE: { code: -32002, message: 'Task not cancelable' },
  PUSH_NOTIFICATION_NOT_SUPPORTED: { code: -32003, message: 'Push notifications not supported' },
  UNSUPPORTED_OPERATION: { code: -32004, message: 'Unsupported operation' },
  CONTENT_TYPE_NOT_SUPPORTED: { code: -32005, message: 'Content type not supported' },
} as const;

export function rpcError(
  id: string | number | null,
  err: typeof RpcErrors[keyof typeof RpcErrors],
  data?: unknown,
): JsonRpcResponse {
  const response: JsonRpcResponse = {
    jsonrpc: '2.0',
    id,
    error: { code: err.code, message: err.message },
  };

  if (data !== undefined) {
    response.error.data = data;
  }

  return response;
}

export function rpcSuccess(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

export interface RpcContext {
  agentName: string;
  allowedAgents: string[];
  isStreaming: boolean;
}

export type RpcMethodHandler = (
  params: unknown,
  ctx: RpcContext,
  req: JsonRpcRequest,
) => Promise<JsonRpcResponse | 'SSE'>;

export class RpcHandler {
  private store: TaskStore;
  private methods: Map<string, RpcMethodHandler>;

  constructor(store: TaskStore) {
    this.store = store;
    this.methods = new Map<string, RpcMethodHandler>();
    this.registerMethods();
  }

  private registerMethods(): void {
    this.methods.set('SendMessage', this.handleSendMessage.bind(this));
    this.methods.set('SendStreamingMessage', this.handleSendStreamingMessage.bind(this));
    this.methods.set('GetTask', this.handleGetTask.bind(this));
    this.methods.set('CancelTask', this.handleCancelTask.bind(this));
    this.methods.set('SubscribeToTask', this.handleSubscribeToTask.bind(this));
    this.methods.set('CreateTaskPushNotificationConfig', this.handleCreatePushConfig.bind(this));
    this.methods.set('GetTaskPushNotificationConfig', this.handleGetPushConfig.bind(this));
    this.methods.set('ListTasks', this.handleListTasks.bind(this));
  }

  async dispatch(req: JsonRpcRequest, ctx: RpcContext): Promise<JsonRpcResponse | 'SSE'> {
    log.debug(`RPC dispatch method=${req.method} agent=${ctx.agentName}`);
    const handler = this.methods.get(req.method);

    if (!handler) {
      return rpcError(req.id, RpcErrors.METHOD_NOT_FOUND);
    }

    try {
      return await handler(req.params, ctx, req);
    } catch (err) {
      log.debug('RPC handler failed:', err);
      return rpcError(req.id, RpcErrors.INTERNAL_ERROR);
    }
  }

  private async handleSendMessage(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    void params;
    void ctx;
    return rpcSuccess(req.id, { status: 'queued' });
  }

  private async handleSendStreamingMessage(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    void params;
    void ctx;
    return rpcSuccess(req.id, { status: 'queued' });
  }

  private async handleGetTask(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    void ctx;
    const { id } = params as { id: string; historyLength?: number };
    const task = this.store.getTask(id);

    if (!task) {
      return rpcError(req.id, RpcErrors.TASK_NOT_FOUND);
    }

    return rpcSuccess(req.id, task);
  }

  private async handleCancelTask(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    void params;
    void ctx;
    return rpcSuccess(req.id, { cancelled: true });
  }

  private async handleSubscribeToTask(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    void params;
    void ctx;
    return rpcSuccess(req.id, { subscribed: true });
  }

  private async handleCreatePushConfig(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    void params;
    void ctx;
    return rpcSuccess(req.id, { created: true });
  }

  private async handleGetPushConfig(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    void params;
    void ctx;
    return rpcSuccess(req.id, { config: null });
  }

  private async handleListTasks(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    void params;
    void ctx;
    const result = this.store.listTasks();
    return rpcSuccess(req.id, { tasks: result.tasks });
  }
}
