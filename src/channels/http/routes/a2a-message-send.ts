import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PermissionHandler } from '@github/copilot-sdk';
import { canAccessAgent, canPerformOp } from '../auth.js';
import type { HttpChannelAdapter } from '../index.js';
import type { RunEntry, RunRegistry } from '../run-registry.js';
import type { PermissionStore } from '../permission-store.js';
import type { PendingPermissionStore } from '../pending-permission-store.js';
import { createAcpPermissionHandler } from '../acp-permission-handler.js';
import type { A2AMessageSendParams, A2ATask } from '../a2a-types.js';
import { runStatusToInitialTaskState } from '../a2a-types.js';

export interface A2AMessageSendRouteDeps {
  adapter: HttpChannelAdapter;
  bots: Record<string, unknown>;
  runRegistry: RunRegistry;
  permissionStore: PermissionStore;
  pendingPermissionStore: PendingPermissionStore;
  checkPermission: (channelId: string, toolName: string, command: string) => Promise<'allow' | 'deny' | null>;
  createSessionWithPermissions: (
    channelId: string,
    bot: string,
    onPermissionRequest: PermissionHandler,
  ) => Promise<{ sessionId: string }>;
}

export type StartTaskResult = {
  ok: true;
  runId: string;
  contextId: string;
  entry: RunEntry;
} | {
  ok: false;
  status: number;
  error: string;
};

export async function validateAndStartTask(
  request: FastifyRequest,
  agentName: string,
  body: Partial<A2AMessageSendParams>,
  deps: A2AMessageSendRouteDeps,
): Promise<StartTaskResult> {
  if (!request.apiKey) {
    return { ok: false, status: 401, error: 'Missing or invalid Authorization header' };
  }
  if (!canPerformOp(request.apiKey, 'agent:execute')) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }
  if (!deps.bots[agentName]) {
    return { ok: false, status: 404, error: 'Agent not found' };
  }
  if (!canAccessAgent(request.apiKey, agentName)) {
    return { ok: false, status: 403, error: 'Not authorized for this agent' };
  }

  const message = body.message;
  if (!message || typeof message !== 'object') {
    return { ok: false, status: 400, error: 'Missing required field: message' };
  }
  if (message.role !== 'user') {
    return { ok: false, status: 400, error: 'message.role must be "user"' };
  }
  if (typeof message.messageId !== 'string' || message.messageId.length === 0) {
    return { ok: false, status: 400, error: 'Missing required field: message.messageId' };
  }
  if (!Array.isArray(message.parts) || message.parts.length === 0) {
    return { ok: false, status: 400, error: 'Missing required field: message.parts' };
  }

  const textParts: string[] = [];
  for (const part of message.parts) {
    if (!part || typeof part !== 'object') {
      return { ok: false, status: 400, error: 'Each message.parts entry must be an object' };
    }
    if ((part as { kind?: unknown }).kind !== 'text') {
      return { ok: false, status: 400, error: 'Only text parts are supported in Phase B' };
    }
    const text = (part as { text?: unknown }).text;
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, status: 400, error: 'Each text part must have a non-empty text field' };
    }
    textParts.push(text);
  }
  const content = textParts.join('');

  const apiKey = request.apiKey;
  const contextId = (typeof message.contextId === 'string' && message.contextId.length > 0)
    ? message.contextId
    : randomUUID();
  const channelId = contextId;

  const existingRun = deps.runRegistry.getNonTerminalActiveRun(channelId);
  if (existingRun) {
    if (existingRun.status === 'awaiting') {
      const error = 'approval abandoned: new run started';
      deps.pendingPermissionStore.resolve(existingRun.runId, 'deny');
      deps.runRegistry.updateStatus(existingRun.runId, 'failed', {
        finishedAt: new Date().toISOString(),
        error,
      });
      deps.runRegistry.getEmitter(existingRun.runId)?.({
        type: 'run.failed',
        data: { run_id: existingRun.runId, error },
      });
    } else {
      return { ok: false, status: 409, error: 'Task already in progress for this contextId' };
    }
  }

  const runIdRef = { current: '' };
  const onPermissionRequest = createAcpPermissionHandler(
    runIdRef,
    channelId,
    deps.permissionStore,
    deps.pendingPermissionStore,
    (runId) => deps.runRegistry.getEmitter(runId),
    deps.checkPermission,
    (runId) => {
      deps.runRegistry.updateStatus(runId, 'awaiting');
    },
  );

  const { sessionId } = await deps.createSessionWithPermissions(channelId, agentName, onPermissionRequest);
  const runId = sessionId;
  runIdRef.current = runId;

  const entry = deps.runRegistry.register(runId, { bot: agentName, channelId, status: 'created' });

  deps.adapter.dispatchInboundMessage({
    platform: 'http',
    channelId,
    userId: apiKey.keyId,
    username: apiKey.keyId,
    text: content,
    postId: runId,
    mentionsBot: true,
    isDM: false,
  });

  return { ok: true, runId, contextId, entry };
}

export function registerA2AMessageSendRoute(app: FastifyInstance, deps: A2AMessageSendRouteDeps): void {
  app.post<{ Params: { name: string }; Body: Partial<A2AMessageSendParams> }>(
    '/agents/:name/message:send',
    async (request, reply) => {
      const result = await validateAndStartTask(request, request.params.name, request.body ?? {}, deps);
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error });
      }

      const task: A2ATask = {
        id: result.runId,
        contextId: result.contextId,
        kind: 'task',
        status: {
          state: runStatusToInitialTaskState(result.entry.status),
          timestamp: result.entry.createdAt,
        },
      };

      return reply.status(200).send(task);
    },
  );
}
