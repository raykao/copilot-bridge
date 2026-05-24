import { approveAll, type CopilotSession, type PermissionHandler } from '@github/copilot-sdk';
import { type SSEStreamingApi } from 'hono/streaming';
import { createLogger } from '../../logger.js';
import { TaskState, type A2AMessage, type A2APlatformConfig, type JsonRpcRequest, type JsonRpcResponse, type Part, type Task, type TaskStateValue } from '../../types.js';
import type { CopilotBridge } from '../../core/bridge.js';
import type { TaskStore } from './task-store.js';
import type { SessionMap } from './session-map.js';
import { PushNotificationDispatcher } from './push-notifications.js';

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
  sseStream?: SSEStreamingApi;
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

interface CreatePushConfigParams {
  taskId: string;
  pushNotificationConfig: {
    url: string;
    token?: string;
  };
}

interface GetPushConfigParams {
  taskId: string;
  pushNotificationConfigId: string;
}

export class RpcHandler {
  private store: TaskStore;
  private sessionMap?: SessionMap;
  private bridge?: CopilotBridge;
  private config?: A2APlatformConfig;
  private pushNotificationDispatcher: PushNotificationDispatcher;
  private pushNotificationsEnabled: boolean;
  private verifyPushNotificationWebhook: boolean;
  private methods: Map<string, RpcMethodHandler>;
  private pendingPermissions = new Map<string, (resolution: { kind: 'approve-once' } | { kind: 'reject'; feedback?: string }) => void>();
  private taskSseStreams = new Map<string, Set<import('hono/streaming').SSEStreamingApi>>();

  constructor(store: TaskStore, sessionMap?: SessionMap, bridge?: CopilotBridge, config?: A2APlatformConfig) {
    this.store = store;
    this.sessionMap = sessionMap;
    this.bridge = bridge;
    this.config = config;
    this.pushNotificationDispatcher = new PushNotificationDispatcher(config?.pushNotifications);
    this.pushNotificationsEnabled = config?.pushNotifications?.enabled ?? false;
    this.verifyPushNotificationWebhook = config?.pushNotifications?.verifyWebhook ?? false;
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

  registerSseStream(taskId: string, stream: SSEStreamingApi): () => void {
    let streams = this.taskSseStreams.get(taskId);
    if (!streams) {
      streams = new Set();
      this.taskSseStreams.set(taskId, streams);
    }
    streams.add(stream);
    return () => {
      const s = this.taskSseStreams.get(taskId);
      if (s) {
        s.delete(stream);
        if (s.size === 0) {
          this.taskSseStreams.delete(taskId);
          const pendingResolve = this.pendingPermissions.get(taskId);
          if (pendingResolve) {
            pendingResolve({ kind: 'reject', feedback: 'SSE subscriber disconnected' });
            this.pendingPermissions.delete(taskId);
          }
        }
      }
    };
  }

  private async emitStatusUpdateToStreams(taskId: string, task: Task): Promise<void> {
    const streams = this.taskSseStreams.get(taskId);
    if (!streams || streams.size === 0) return;
    const payload = JSON.stringify({ statusUpdate: { taskId, status: task.status, final: false } });
    for (const stream of streams) {
      try {
        await stream.writeSSE({ data: payload });
      } catch {
        // stream disconnected -- ignore
      }
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
        const resolve = this.pendingPermissions.get(existingTask.id);
        if (!resolve) {
          return rpcError(req.id, RpcErrors.INTERNAL_ERROR, 'No pending permission for this task');
        }
        const approved = text.trim().toLowerCase() === 'approved';
        if (approved) {
          resolve({ kind: 'approve-once' });
        } else {
          resolve({ kind: 'reject', feedback: text });
        }
        this.pendingPermissions.delete(existingTask.id);
        const resumedTask = this.store.updateTask(existingTask.id, {
          status: { state: TaskState.WORKING, timestamp },
        });
        this.emitStatusUpdateToStreams(existingTask.id, resumedTask).catch(() => {});
        return rpcSuccess(req.id, resumedTask);
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
    const taskId = crypto.randomUUID();
    const session = existingSessionId
      ? await this.bridge.resumeSession(existingSessionId, this.buildSessionOptions(ctx.agentName, taskId))
      : await this.bridge.createSession(this.buildSessionOptions(ctx.agentName, taskId));
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

  private async handleSendStreamingMessage(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse | 'SSE'> {
    void req;
    if (!ctx.sseStream) return 'SSE';

    if (!this.bridge || !this.sessionMap || !this.config) {
      await ctx.sseStream.close();
      return 'SSE';
    }

    if (!isSendMessageParams(params)) {
      await ctx.sseStream.close();
      return 'SSE';
    }

    const stream = ctx.sseStream;
    const message = params.message;
    const text = extractText(message.parts);
    const timestamp = new Date().toISOString();

    const providedContextId = message.contextId;
    const existingSessionId = providedContextId
      ? this.sessionMap.getSessionForContext(providedContextId)
      : undefined;
    const taskId = crypto.randomUUID();
    const session = existingSessionId
      ? await this.bridge.resumeSession(existingSessionId, this.buildSessionOptions(ctx.agentName, taskId))
      : await this.bridge.createSession(this.buildSessionOptions(ctx.agentName, taskId));

    const task = this.store.createTask({
      id: taskId,
      contextId: providedContextId,
      sessionId: session.sessionId,
      status: { state: TaskState.SUBMITTED, timestamp },
    });
    this.sessionMap.link(task.id, task.contextId, session.sessionId);
    const unregisterSseStream = this.registerSseStream(task.id, stream);

    await stream.writeSSE({ data: JSON.stringify({ task }) });

    const done = createDeferred();
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      writeKeepAlive(stream).catch(() => {});
    }, 15_000);
    if (typeof heartbeatTimer === 'object' && heartbeatTimer !== null && 'unref' in heartbeatTimer) {
      (heartbeatTimer as any).unref();
    }

    let unsubscribe: (() => void) | undefined;
    const cleanup = (): void => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (unsubscribe) {
        const unsubscribeOnce = unsubscribe;
        unsubscribe = undefined;
        unsubscribeOnce();
      }
      unregisterSseStream();
    };

    let closing = false;
    const beginClosing = (): boolean => {
      if (closing) return false;
      closing = true;
      cleanup();
      return true;
    };
    const finishClosing = async (): Promise<void> => {
      try {
        await stream.close();
      } finally {
        done.resolve();
      }
    };
    const waitForClose = async (): Promise<void> => {
      await done.promise;
    };

    const artifactId = crypto.randomUUID();
    let textBuffer = '';

    unsubscribe = session.on(async (event: any) => {
      const ts = new Date().toISOString();
      if (event.type === 'assistant.turn_start') {
        const workingTask = this.store.updateTask(taskId, {
          status: { state: TaskState.WORKING, timestamp: ts },
        });
        await stream.writeSSE({
          data: JSON.stringify({
            statusUpdate: { taskId, status: workingTask.status, final: false },
          }),
        });
      } else if (event.type === 'assistant.message_delta') {
        const delta: string = event.data?.content ?? event.data?.delta ?? '';
        textBuffer += delta;
        await stream.writeSSE({
          data: JSON.stringify({
            artifactUpdate: {
              taskId,
              artifact: {
                artifactId,
                parts: [{ kind: 'text', text: delta }],
              },
              append: true,
              lastChunk: false,
            },
          }),
        });
      } else if (event.type === 'tool.execution_start') {
        const toolName: string = event.data?.toolName ?? event.data?.name ?? '';
        const toolCallId: string = event.data?.toolCallId ?? event.data?.id ?? '';
        const input: unknown = event.data?.input ?? event.data?.arguments ?? {};
        await stream.writeSSE({
          data: JSON.stringify({
            artifactUpdate: {
              taskId,
              artifact: {
                artifactId: crypto.randomUUID(),
                parts: [{ kind: 'data', data: { kind: 'tool_start', toolName, toolCallId, input } }],
              },
              append: true,
              lastChunk: false,
            },
          }),
        });
      } else if (event.type === 'tool.execution_complete') {
        const toolName: string = event.data?.toolName ?? event.data?.name ?? '';
        const toolCallId: string = event.data?.toolCallId ?? event.data?.id ?? '';
        const output: unknown = event.data?.output ?? event.data?.result ?? {};
        await stream.writeSSE({
          data: JSON.stringify({
            artifactUpdate: {
              taskId,
              artifact: {
                artifactId: crypto.randomUUID(),
                parts: [{ kind: 'data', data: { kind: 'tool_complete', toolName, toolCallId, output } }],
              },
              append: true,
              lastChunk: false,
            },
          }),
        });
      } else if (event.type === 'session.idle') {
        if (!beginClosing()) return;
        const completedTask = this.store.updateTask(taskId, {
          status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
          ...(textBuffer ? {
            artifacts: [{
              artifactId,
              parts: [{ kind: 'text', text: textBuffer }],
            }],
          } : {}),
        });
        try {
          await stream.writeSSE({
            data: JSON.stringify({
              statusUpdate: { taskId, status: completedTask.status, final: true },
            }),
          });
        } finally {
          await finishClosing();
        }
      } else if (event.type === 'session.error' || event.type === 'session.shutdown') {
        if (!beginClosing()) return;
        const failedTask = this.store.updateTask(taskId, {
          status: { state: TaskState.FAILED, timestamp: new Date().toISOString(), message: buildErrorMessage(event) ?? buildStatusMessage('Session failed') },
        });
        try {
          await stream.writeSSE({
            data: JSON.stringify({
              statusUpdate: { taskId, status: failedTask.status, final: true },
            }),
          });
        } finally {
          await finishClosing();
        }
      }
    });

    try {
      await session.send({ prompt: text });
    } catch (err) {
      if (closing) {
        await waitForClose();
        return 'SSE';
      }
      beginClosing();
      const failedTask = this.store.updateTask(taskId, {
        status: { state: TaskState.FAILED, timestamp: new Date().toISOString(), message: buildErrorMessage(err) ?? buildStatusMessage('Session send failed') },
      });
      try {
        await stream.writeSSE({
          data: JSON.stringify({
            statusUpdate: { taskId, status: failedTask.status, final: true },
          }),
        });
      } finally {
        await finishClosing();
      }
      return 'SSE';
    }

    await done.promise;
    return 'SSE';
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

  private async handleSubscribeToTask(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse | 'SSE'> {
    void req;
    if (!ctx.sseStream) return 'SSE';

    const stream = ctx.sseStream;
    if (!isRecord(params) || typeof params.id !== 'string') {
      await stream.close();
      return 'SSE';
    }

    const taskId = params.id;
    const task = this.store.getTask(taskId);
    if (!task) {
      await stream.close();
      return 'SSE';
    }

    await stream.writeSSE({ data: JSON.stringify({ task }) });

    const terminalStates: TaskStateValue[] = [
      TaskState.COMPLETED,
      TaskState.FAILED,
      TaskState.CANCELED,
      TaskState.REJECTED,
    ];

    if (terminalStates.includes(task.status.state)) {
      await stream.close();
      return 'SSE';
    }

    const done = createDeferred();
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
      writeKeepAlive(stream).catch(() => {});
    }, 15_000);
    if (typeof heartbeatTimer === 'object' && heartbeatTimer !== null && 'unref' in heartbeatTimer) {
      (heartbeatTimer as any).unref();
    }

    let unsubscribe: (() => void) | undefined;
    const unregisterSseStream = this.registerSseStream(taskId, stream);
    const cleanup = (): void => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (unsubscribe) {
        const unsubscribeOnce = unsubscribe;
        unsubscribe = undefined;
        unsubscribeOnce();
      }
      unregisterSseStream();
    };

    let closing = false;
    const closeAndResolve = async (): Promise<void> => {
      if (closing) return;
      closing = true;
      cleanup();
      try {
        await stream.close();
      } finally {
        done.resolve();
      }
    };

    unsubscribe = this.store.subscribeToTask(taskId, (updatedTask) => {
      const final = terminalStates.includes(updatedTask.status.state);
      stream.writeSSE({
        data: JSON.stringify({
          statusUpdate: { taskId, status: updatedTask.status, final },
        }),
      }).then(async () => {
        if (final) {
          await closeAndResolve();
        }
      }).catch(async () => {
        await closeAndResolve();
      });
    });

    await done.promise;
    return 'SSE';
  }

  private async handleCreatePushConfig(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    void ctx;
    const { taskId, pushNotificationConfig } = params as CreatePushConfigParams;
    const task = this.store.getTask(taskId);

    if (!task) {
      return rpcError(req.id, RpcErrors.TASK_NOT_FOUND);
    }

    if (!this.pushNotificationsEnabled) {
      return rpcError(req.id, RpcErrors.PUSH_NOTIFICATION_NOT_SUPPORTED);
    }

    if (this.verifyPushNotificationWebhook) {
      const reachable = await this.pushNotificationDispatcher.verifyWebhookUrl(pushNotificationConfig.url);
      if (!reachable) {
        return rpcError(req.id, RpcErrors.INVALID_PARAMS, 'Webhook URL not reachable');
      }
    }

    const config = this.store.addPushConfig(taskId, {
      url: pushNotificationConfig.url,
      token: pushNotificationConfig.token,
    });
    return rpcSuccess(req.id, config);
  }

  private async handleGetPushConfig(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    void ctx;
    const { taskId, pushNotificationConfigId } = params as GetPushConfigParams;
    const config = this.store.getPushConfig(taskId, pushNotificationConfigId);

    if (!config) {
      return rpcError(req.id, RpcErrors.TASK_NOT_FOUND);
    }

    return rpcSuccess(req.id, config);
  }

  private async handleListTasks(params: unknown, ctx: RpcContext, req: JsonRpcRequest): Promise<JsonRpcResponse> {
    void params;
    void ctx;
    const result = this.store.listTasks();
    return rpcSuccess(req.id, { tasks: result.tasks });
  }

  private buildHitlPermissionHandler(taskId: string): PermissionHandler {
    return (request, _invocation) => {
      const timestamp = new Date().toISOString();

      let updatedTask: Task;
      try {
        updatedTask = this.store.updateTask(taskId, {
          status: {
            state: TaskState.INPUT_REQUIRED,
            timestamp,
            message: {
              role: 'agent',
              parts: [
                { kind: 'text', text: `Permission required: ${request.kind}` },
                { kind: 'data', data: { kind: 'permission_request', permissionKind: request.kind, toolCallId: request.toolCallId } },
              ],
            },
          },
        });
      } catch {
        return Promise.resolve({ kind: 'reject' });
      }

      this.emitStatusUpdateToStreams(taskId, updatedTask).catch(() => {});

      return new Promise((resolve) => {
        this.pendingPermissions.set(taskId, resolve);
      });
    };
  }

  private buildSessionOptions(agentName: string, taskId?: string): Parameters<CopilotBridge['createSession']>[0] {
    const bot = this.config?.bots[agentName];
    const home = process.env.HOME;
    const onPermissionRequest = taskId ? this.buildHitlPermissionHandler(taskId) : approveAll;
    return {
      model: bot?.model,
      agent: bot?.agent,
      workingDirectory: process.cwd(),
      ...(home ? { configDir: `${home}/.copilot` } : {}),
      enableConfigDiscovery: true,
      onPermissionRequest,
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

    const cleanupPendingPermission = (): void => {
      const pendingResolve = this.pendingPermissions.get(taskId);
      if (pendingResolve) {
        pendingResolve({ kind: 'reject', feedback: 'Task terminated' });
        this.pendingPermissions.delete(taskId);
      }
    };

    const cancel = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      cleanupPendingPermission();
    };

    const promise = new Promise<Task>((resolve) => {
      const resolveCompleted = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        cleanupPendingPermission();
        resolve(this.store.updateTask(taskId, {
          status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
        }));
      };

      const resolveFailed = (message?: A2AMessage): void => {
        if (settled) return;
        settled = true;
        cleanup();
        cleanupPendingPermission();
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

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function writeKeepAlive(stream: SSEStreamingApi): Promise<void> {
  const writableStream = stream as SSEStreamingApi & { write?: (chunk: string) => Promise<void> };
  if (typeof writableStream.write === 'function') {
    await writableStream.write(': keep-alive\n\n');
    return;
  }

  await stream.writeSSE({ data: '' });
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
