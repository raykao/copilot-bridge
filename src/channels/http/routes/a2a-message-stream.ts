import type { SessionEvent } from '@github/copilot-sdk';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createLogger } from '../../../logger.js';
import {
  validateAndStartTask,
  type A2AMessageSendRouteDeps,
} from './a2a-message-send.js';
import { mapSdkEventToA2A, isTerminalA2AEvent } from './a2a-events.js';
import type {
  A2AMessageSendParams,
  A2AStreamEvent,
  A2ATask,
  A2ATaskState,
  A2ATaskStatusUpdateEvent,
} from '../a2a-types.js';
import { runStatusToInitialTaskState } from '../a2a-types.js';
import type { RunRegistry } from '../run-registry.js';

const log = createLogger('a2a-message-stream');

export interface A2AMessageStreamRouteDeps extends A2AMessageSendRouteDeps {
  subscribeToSessionEvents: (
    channelId: string,
    handler: (sessionId: string, channelId: string, event: any) => void,
  ) => () => void;
  getSession: (sessionId: string) => { getMessages(): Promise<SessionEvent[]> } | undefined;
}

export interface AttachA2AStreamDeps {
  runRegistry: RunRegistry;
  subscribeToSessionEvents: (
    channelId: string,
    handler: (sessionId: string, channelId: string, event: any) => void,
  ) => () => void;
}

export interface AttachA2AStreamCtx {
  taskId: string;
  contextId: string;
  initialTask: A2ATask | null;
  replayTerminal: boolean;
  terminalReplaySession: { getMessages(): Promise<SessionEvent[]> } | undefined;
  terminalStatus?: Extract<A2ATaskState, 'completed' | 'failed' | 'canceled'>;
  terminalError?: string;
}

export function registerA2AMessageStreamRoute(app: FastifyInstance, deps: A2AMessageStreamRouteDeps): void {
  app.post<{ Params: { name: string }; Body: Partial<A2AMessageSendParams> }>(
    '/agents/:name/message::stream',
    async (request, reply) => {
      const result = await validateAndStartTask(request, request.params.name, request.body ?? {}, deps);
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error });
      }

      writeStreamHeaders(reply);
      reply.hijack();

      const { runId, contextId, entry } = result;
      const initialTask: A2ATask = {
        id: runId,
        contextId,
        kind: 'task',
        status: {
          state: runStatusToInitialTaskState(entry.status),
          timestamp: entry.createdAt,
        },
      };

      attachA2AStream(reply, request, deps, {
        taskId: runId,
        contextId,
        initialTask,
        replayTerminal: false,
        terminalReplaySession: undefined,
      });
    },
  );
}

export function attachA2AStream(
  reply: FastifyReply,
  request: FastifyRequest,
  deps: AttachA2AStreamDeps,
  ctx: AttachA2AStreamCtx,
): void {
  if (ctx.initialTask) {
    writeA2AEvent(reply.raw, 'task', ctx.initialTask);
  }

  if (ctx.replayTerminal) {
    void replayTerminalStream(reply, ctx);
    return;
  }

  let closed = false;
  let unsubscribe: (() => void) | undefined;
  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    deps.runRegistry.setEmitter(ctx.taskId, () => undefined);
    reply.raw.end();
  };

  deps.runRegistry.setEmitter(ctx.taskId, (sdkEvent) => {
    if (closed) return;
    const a2aEvent = mapSdkEventToA2A(sdkEvent as SessionEvent, ctx);
    if (!a2aEvent) return;
    writeA2AEvent(reply.raw, eventNameFor(a2aEvent), a2aEvent);
    if (isTerminalA2AEvent(a2aEvent)) close();
  });

  unsubscribe = deps.subscribeToSessionEvents(ctx.contextId, (_sessionId, channelId, event) => {
    if (closed || channelId !== ctx.contextId) return;

    const terminal = isTerminalSdkEvent(event);
    if (terminal && deps.runRegistry.shouldSuppressCancellationTerminal(ctx.taskId, ctx.contextId, event)) {
      return;
    }
    if (!terminal && !deps.runRegistry.isActiveRun(ctx.taskId)) {
      return;
    }

    const a2aEvent = mapSdkEventToA2A(event as SessionEvent, ctx);
    if (a2aEvent) {
      writeA2AEvent(reply.raw, eventNameFor(a2aEvent), a2aEvent);
    }
    if (terminal) close();
  });

  request.raw.on('close', () => {
    log.debug('A2A stream client disconnected', { runId: ctx.taskId });
    close();
  });
}

async function replayTerminalStream(reply: FastifyReply, ctx: AttachA2AStreamCtx): Promise<void> {
  try {
    const sdkEvents = await ctx.terminalReplaySession?.getMessages() ?? [];
    for (const event of sdkEvents) {
      if (isTerminalSdkEvent(event)) {
        continue;
      }
      const a2aEvent = mapSdkEventToA2A(event, ctx);
      if (a2aEvent) {
        writeA2AEvent(reply.raw, eventNameFor(a2aEvent), a2aEvent);
      }
    }
    writeA2AEvent(reply.raw, 'status-update', terminalStatusEvent(ctx));
  } catch (error) {
    log.warn('Failed to replay terminal A2A stream', { taskId: ctx.taskId, error });
  } finally {
    reply.raw.end();
  }
}

function terminalStatusEvent(ctx: AttachA2AStreamCtx): A2ATaskStatusUpdateEvent {
  const status: A2ATaskStatusUpdateEvent['status'] = {
    state: ctx.terminalStatus ?? 'completed',
  };
  if (ctx.terminalError) {
    status.message = {
      role: 'agent',
      messageId: `${ctx.taskId}-error`,
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      parts: [{ kind: 'text', text: ctx.terminalError }],
    };
  }
  return {
    taskId: ctx.taskId,
    contextId: ctx.contextId,
    kind: 'status-update',
    final: true,
    status,
  };
}

function writeStreamHeaders(reply: { raw: { writeHead: (status: number, headers: Record<string, string>) => void } }): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function writeA2AEvent(raw: { write: (chunk: string) => void }, eventName: string, payload: unknown): void {
  raw.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function eventNameFor(event: A2AStreamEvent): string {
  if ((event as { kind?: string }).kind === 'status-update') return 'status-update';
  if ((event as { kind?: string }).kind === 'artifact-update') return 'artifact-update';
  return 'task';
}

function isTerminalSdkEvent(event: { type?: string }): boolean {
  return event.type === 'session.idle' || event.type === 'session.error';
}
