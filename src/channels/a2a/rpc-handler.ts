import { approveAll, type CopilotSession } from '@github/copilot-sdk';
import { createLogger } from '../../logger.js';
import { TaskState, type A2AMessage, type A2APlatformConfig, type JsonRpcRequest, type JsonRpcResponse, type Part, type Task } from '../../types.js';
import type { CopilotBridge } from '../../core/bridge.js';
import type { TaskStore } from './task-store.js';
import type { SessionMap } from './session-map.js';

const log = createLogger('a2a:rpc');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const IDLE_DEBOUNCE_MS = 2_000;

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

interface SendMessageConfiguration {
  returnImmediately?: boolean;
  taskId?: string;
}

interface SendMessageParams {
  message: A2AMessage;
  configuration?: SendMessageConfiguration | null;
}

export class RpcHandler {
  private store: TaskStore;
  private sessionMap?: SessionMap;
  private bridge?: CopilotBridge;
  private config?: A2APlatformConfig;
  private methods: Map<string, RpcMethodHandler>;

  constructor(store: TaskStore, sessionMap?: SessionMap, bridge?: CopilotBridge, config?: A2APlatformConfig) {
    this.store = store;
    this.sessionMap = sessionMap;
    this.bridge = bridge;
    this.config = config;
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
    if (!this.bridge || !this.sessionMap || !this.config) {
      return rpcError(req.id, RpcErrors.INTERNAL_ERROR, 'A2A session routing is not configured');
    }

    if (!isSendMessageParams(params)) {
      return rpcError(req.id, RpcErrors.INVALID_PARAMS);
    }

    const message = params.message;
    const requestConfig = params.configuration ?? {};
    const text = extractText(message.parts);
    const timestamp = new Date().toISOString();

    if (requestConfig.taskId) {
      const existingTask = this.store.getTask(requestConfig.taskId);
      if (!existingTask) {
        return rpcError(req.id, RpcErrors.TASK_NOT_FOUND);
      }

      if (existingTask.status.state === TaskState.INPUT_REQUIRED) {
        // TODO(T12): handle approval and continuation messages for input-required tasks.
        return rpcSuccess(req.id, existingTask);
      }

      const sessionId = this.sessionMap.getSessionForTask(existingTask.id) ?? getSessionIdFromTask(existingTask);
      if (!sessionId) {
        return rpcError(req.id, RpcErrors.INTERNAL_ERROR, 'No Copilot session is linked to this task');
      }

      const session = await this.bridge.resumeSession(sessionId, this.buildSessionOptions(ctx.agentName));
      const workingTask = this.store.updateTask(existingTask.id, {
        status: { state: TaskState.WORKING, timestamp },
      });
      const terminalTask = this.watchTerminalTask(session, workingTask.id);

      try {
        await session.send({ prompt: text });
      } catch (err) {
        terminalTask.cancel();
        const failedMessage = buildErrorMessage(err) ?? buildStatusMessage('Session send failed');
        return rpcSuccess(req.id, this.store.updateTask(workingTask.id, {
          status: { state: TaskState.FAILED, timestamp: new Date().toISOString(), message: failedMessage },
        }));
      }

      if (requestConfig.returnImmediately) {
        return rpcSuccess(req.id, workingTask);
      }

      return rpcSuccess(req.id, await terminalTask.promise);
    }

    const providedContextId = message.contextId;
    const existingSessionId = providedContextId ? this.sessionMap.getSessionForContext(providedContextId) : undefined;
    const session = existingSessionId
      ? await this.bridge.resumeSession(existingSessionId, this.buildSessionOptions(ctx.agentName))
      : await this.bridge.createSession(this.buildSessionOptions(ctx.agentName));
    const taskId = crypto.randomUUID();
    const task = this.store.createTask({
      id: taskId,
      contextId: providedContextId,
      sessionId: session.sessionId,
      status: { state: TaskState.WORKING, timestamp },
    });
    this.sessionMap.link(task.id, task.contextId, session.sessionId);
    const workingTask = this.store.updateTask(task.id, {
      status: { state: TaskState.WORKING, timestamp: new Date().toISOString() },
    });
    const terminalTask = this.watchTerminalTask(session, workingTask.id);

    try {
      await session.send({ prompt: text });
    } catch (err) {
      terminalTask.cancel();
      const failedMessage = buildErrorMessage(err) ?? buildStatusMessage('Session send failed');
      return rpcSuccess(req.id, this.store.updateTask(workingTask.id, {
        status: { state: TaskState.FAILED, timestamp: new Date().toISOString(), message: failedMessage },
      }));
    }

    if (requestConfig.returnImmediately) {
      return rpcSuccess(req.id, workingTask);
    }

    return rpcSuccess(req.id, await terminalTask.promise);
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

  private buildSessionOptions(agentName: string): Parameters<CopilotBridge['createSession']>[0] {
    const bot = this.config?.bots[agentName];
    const home = process.env.HOME;
    return {
      model: bot?.model,
      agent: bot?.agent,
      workingDirectory: process.cwd(),
      ...(home ? { configDir: `${home}/.copilot` } : {}),
      enableConfigDiscovery: true,
      onPermissionRequest: approveAll,
    };
  }

  private watchTerminalTask(session: CopilotSession, taskId: string): { promise: Promise<Task>; cancel: () => void } {
    let unsubscribe: (() => void) | undefined;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const clearIdleTimer = (): void => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };

    const cleanup = (): void => {
      clearIdleTimer();
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = undefined;
      }
      if (unsubscribe) {
        const unsubscribeOnce = unsubscribe;
        unsubscribe = undefined;
        unsubscribeOnce();
      }
    };

    const cancel = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
    };

    const promise = new Promise<Task>((resolve) => {
      const resolveCompleted = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(this.store.updateTask(taskId, {
          status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
        }));
      };

      const resolveFailed = (message?: A2AMessage): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(this.store.updateTask(taskId, {
          status: {
            state: TaskState.FAILED,
            timestamp: new Date().toISOString(),
            message,
          },
        }));
      };

      timeoutTimer = setTimeout(() => {
        resolveFailed(buildStatusMessage(`Task timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`));
      }, DEFAULT_TIMEOUT_MS);
      unrefTimer(timeoutTimer);

      unsubscribe = session.on((event) => {
        if (settled) return;

        if (event.type === 'session.idle') {
          clearIdleTimer();
          idleTimer = setTimeout(resolveCompleted, IDLE_DEBOUNCE_MS);
          unrefTimer(idleTimer);
          return;
        }

        if (event.type === 'session.error') {
          resolveFailed(buildErrorMessage(event));
          return;
        }

        if (event.type === 'session.shutdown') {
          resolveFailed(buildStatusMessage('Session shut down before task completed'));
        }
      });
    });

    return { promise, cancel };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPart(value: unknown): value is Part {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    return false;
  }

  if (value.kind === 'text') {
    return typeof value.text === 'string';
  }

  if (value.kind === 'data') {
    return isRecord(value.data);
  }

  if (value.kind === 'file') {
    return isRecord(value.file);
  }

  return false;
}

function isA2AMessage(value: unknown): value is A2AMessage {
  return isRecord(value)
    && (value.role === 'user' || value.role === 'agent')
    && Array.isArray(value.parts)
    && value.parts.every(isPart)
    && (value.contextId === undefined || typeof value.contextId === 'string')
    && (value.taskId === undefined || typeof value.taskId === 'string')
    && (value.messageId === undefined || typeof value.messageId === 'string');
}

function isSendMessageConfiguration(value: unknown): value is SendMessageConfiguration {
  return value == null || (isRecord(value)
    && (value.returnImmediately === undefined || typeof value.returnImmediately === 'boolean')
    && (value.taskId === undefined || typeof value.taskId === 'string'));
}

function isSendMessageParams(value: unknown): value is SendMessageParams {
  return isRecord(value)
    && isA2AMessage(value.message)
    && isSendMessageConfiguration(value.configuration);
}

function extractText(parts: Part[]): string {
  return parts.find((part) => part.kind === 'text')?.text ?? '';
}

function getSessionIdFromTask(task: Task): string | undefined {
  const sessionId = task.metadata?.sessionId;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

function buildStatusMessage(text: string): A2AMessage {
  return {
    role: 'agent',
    parts: [{ kind: 'text', text }],
  };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

function buildErrorMessage(event: unknown): A2AMessage | undefined {
  const data = isRecord(event) && isRecord(event.data) ? event.data : undefined;
  const topLevelMessage = isRecord(event) ? event.message : undefined;
  const message = data?.message ?? topLevelMessage;
  const content = data?.content;
  const text = typeof message === 'string' ? message : typeof content === 'string' ? content : undefined;
  if (!text) {
    return undefined;
  }

  return {
    role: 'agent',
    parts: [{ kind: 'text', text }],
  };
}
