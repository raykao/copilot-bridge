import type { SessionEvent } from '@github/copilot-sdk';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canAccessAgent, canPerformOp } from '../auth.js';
import type { RunEntry, RunStatus } from '../run-registry.js';
import type { A2ATask, A2ATaskState } from '../a2a-types.js';
import { runStatusToTaskState } from '../a2a-types.js';
import { attachA2AStream, type AttachA2AStreamDeps } from './a2a-message-stream.js';

interface TasksIdBody { id?: string }

export interface A2ATasksRouteDeps extends AttachA2AStreamDeps {
  bots: Record<string, unknown>;
  getSession: (sessionId: string) => { getMessages(): Promise<SessionEvent[]> } | undefined;
  abortSession: (sessionId: string) => Promise<void>;
}

export function registerA2ATasksRoutes(app: FastifyInstance, deps: A2ATasksRouteDeps): void {
  app.post<{ Params: { name: string }; Body: TasksIdBody }>(
    '/agents/:name/tasks::get',
    async (request, reply) => {
      const checked = checkAuthAndLookup(request, reply, deps, 'agent:read');
      if (!checked.ok) return;

      return reply.status(200).send(taskSnapshot(checked.entry));
    },
  );

  app.post<{ Params: { name: string }; Body: TasksIdBody }>(
    '/agents/:name/tasks::cancel',
    async (request, reply) => {
      const checked = checkAuthAndLookup(request, reply, deps, 'agent:execute');
      if (!checked.ok) return;
      const { entry } = checked;

      if (isTerminalRunStatus(entry.status)) {
        return reply.status(200).send(taskSnapshot(entry));
      }

      const finishedAt = new Date().toISOString();
      deps.runRegistry.recordCancellationSuppression(entry.runId, entry.channelId);
      deps.runRegistry.updateStatus(entry.runId, 'cancelled', { finishedAt });
      deps.runRegistry.getEmitter(entry.runId)?.({
        type: 'session.error',
        data: { message: 'cancelled' },
      });
      await deps.abortSession(entry.runId).catch(() => {});

      return reply.status(200).send({
        id: entry.runId,
        contextId: entry.channelId,
        kind: 'task',
        status: { state: 'canceled', timestamp: finishedAt },
      } satisfies A2ATask);
    },
  );

  app.post<{ Params: { name: string }; Body: TasksIdBody }>(
    '/agents/:name/tasks::resubscribe',
    async (request, reply) => {
      const checked = checkAuthAndLookup(request, reply, deps, 'agent:read');
      if (!checked.ok) return;
      const { entry } = checked;

      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      reply.hijack();

      if (isTerminalRunStatus(entry.status)) {
        attachA2AStream(reply, request, deps, {
          taskId: entry.runId,
          contextId: entry.channelId,
          initialTask: null,
          replayTerminal: true,
          terminalReplaySession: deps.getSession(entry.runId),
          terminalStatus: terminalStateOf(entry.status),
          terminalError: entry.error,
        });
        return;
      }

      attachA2AStream(reply, request, deps, {
        taskId: entry.runId,
        contextId: entry.channelId,
        initialTask: null,
        replayTerminal: false,
        terminalReplaySession: undefined,
      });
    },
  );
}

type CheckOk = { ok: true; entry: RunEntry };
type CheckErr = { ok: false };

function checkAuthAndLookup(
  request: FastifyRequest<{ Params: { name: string }; Body: TasksIdBody }>,
  reply: FastifyReply,
  deps: A2ATasksRouteDeps,
  requiredOp: 'agent:read' | 'agent:execute',
): CheckOk | CheckErr {
  if (!request.apiKey) {
    reply.status(401).send({ error: 'Missing or invalid Authorization header' });
    return { ok: false };
  }
  if (!canPerformOp(request.apiKey, requiredOp)) {
    reply.status(403).send({ error: 'Forbidden' });
    return { ok: false };
  }
  const agentName = request.params.name;
  if (!deps.bots[agentName]) {
    reply.status(404).send({ error: 'Agent not found' });
    return { ok: false };
  }
  if (!canAccessAgent(request.apiKey, agentName)) {
    reply.status(403).send({ error: 'Not authorized for this agent' });
    return { ok: false };
  }
  const id = request.body?.id;
  if (typeof id !== 'string' || id.length === 0) {
    reply.status(400).send({ error: 'Missing required field: id' });
    return { ok: false };
  }
  const entry = deps.runRegistry.get(id);
  if (!entry || entry.bot !== agentName) {
    reply.status(404).send({ error: 'Task not found' });
    return { ok: false };
  }
  return { ok: true, entry };
}

function taskSnapshot(entry: RunEntry): A2ATask {
  const task: A2ATask = {
    id: entry.runId,
    contextId: entry.channelId,
    kind: 'task',
    status: {
      state: runStatusToTaskState(entry.status),
      timestamp: entry.finishedAt ?? entry.createdAt,
    },
  };

  if (entry.status === 'failed' && entry.error) {
    task.status.message = {
      role: 'agent',
      parts: [{ kind: 'text', text: entry.error }],
      messageId: `${entry.runId}-error`,
      taskId: entry.runId,
      contextId: entry.channelId,
    };
  }

  return task;
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function terminalStateOf(status: RunStatus): Extract<A2ATaskState, 'completed' | 'failed' | 'canceled'> {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  return 'canceled';
}
