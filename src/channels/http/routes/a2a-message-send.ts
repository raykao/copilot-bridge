import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PermissionHandler } from '@github/copilot-sdk';
import { canAccessAgent, canPerformOp } from '../auth.js';
import type { HttpChannelAdapter } from '../index.js';
import type { RunRegistry } from '../run-registry.js';
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

export function registerA2AMessageSendRoute(app: FastifyInstance, deps: A2AMessageSendRouteDeps): void {
  app.post<{ Params: { name: string }; Body: Partial<A2AMessageSendParams> }>(
    '/agents/:name/message:send',
    async (request, reply) => {
      const agentName = request.params.name;

      if (!request.apiKey) {
        return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
      }
      if (!canPerformOp(request.apiKey, 'agent:execute')) {
        return reply.status(403).send({ error: 'Forbidden' });
      }
      if (!deps.bots[agentName]) {
        return reply.status(404).send({ error: 'Agent not found' });
      }
      if (!canAccessAgent(request.apiKey, agentName)) {
        return reply.status(403).send({ error: 'Not authorized for this agent' });
      }

      const message = request.body?.message;
      if (!message || typeof message !== 'object') {
        return reply.status(400).send({ error: 'Missing required field: message' });
      }
      if (message.role !== 'user') {
        return reply.status(400).send({ error: 'message.role must be "user"' });
      }
      if (typeof message.messageId !== 'string' || message.messageId.length === 0) {
        return reply.status(400).send({ error: 'Missing required field: message.messageId' });
      }
      if (!Array.isArray(message.parts) || message.parts.length === 0) {
        return reply.status(400).send({ error: 'Missing required field: message.parts' });
      }

      const textParts: string[] = [];
      for (const part of message.parts) {
        if (!part || typeof part !== 'object') {
          return reply.status(400).send({ error: 'Each message.parts entry must be an object' });
        }
        if ((part as { kind?: unknown }).kind !== 'text') {
          return reply.status(400).send({ error: 'Only text parts are supported in Phase B' });
        }
        const text = (part as { text?: unknown }).text;
        if (typeof text !== 'string' || text.length === 0) {
          return reply.status(400).send({ error: 'Each text part must have a non-empty text field' });
        }
        textParts.push(text);
      }
      const content = textParts.join('');

      const apiKey = request.apiKey;
      const contextId = (typeof message.contextId === 'string' && message.contextId.length > 0)
        ? message.contextId
        : randomUUID();
      const channelId = contextId;

      // Reject continuation on a session that already has an active run
      const existingRun = deps.runRegistry.getNonTerminalActiveRun(channelId);
      if (existingRun) {
        return reply.status(409).send({ error: 'Task already in progress for this contextId' });
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

      const task: A2ATask = {
        id: runId,
        contextId,
        kind: 'task',
        status: {
          state: runStatusToInitialTaskState(entry.status),
          timestamp: entry.createdAt,
        },
      };

      return reply.status(200).send(task);
    },
  );
}
