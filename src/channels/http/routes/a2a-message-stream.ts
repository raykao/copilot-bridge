import type { SessionEvent } from '@github/copilot-sdk';
import type { FastifyInstance } from 'fastify';
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
} from '../a2a-types.js';
import { runStatusToInitialTaskState } from '../a2a-types.js';

const log = createLogger('a2a-message-stream');

export interface A2AMessageStreamRouteDeps extends A2AMessageSendRouteDeps {
  subscribeToSessionEvents: (
    channelId: string,
    handler: (sessionId: string, channelId: string, event: any) => void,
  ) => () => void;
  getSession: (sessionId: string) => { getMessages(): Promise<SessionEvent[]> } | undefined;
}

export function registerA2AMessageStreamRoute(app: FastifyInstance, deps: A2AMessageStreamRouteDeps): void {
  app.post<{ Params: { name: string }; Body: Partial<A2AMessageSendParams> }>(
    '/agents/:name/message:stream',
    async (request, reply) => {
      const result = await validateAndStartTask(request, request.params.name, request.body ?? {}, deps);
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error });
      }

      writeStreamHeaders(reply);
      reply.hijack();

      const { runId, contextId, entry } = result;
      const ctx = { taskId: runId, contextId };

      const initialTask: A2ATask = {
        id: runId,
        contextId,
        kind: 'task',
        status: {
          state: runStatusToInitialTaskState(entry.status),
          timestamp: entry.createdAt,
        },
      };
      writeA2AEvent(reply.raw, 'task', initialTask);

      let closed = false;
      let unsubscribe: (() => void) | undefined;
      const close = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        deps.runRegistry.setEmitter(runId, () => undefined);
        reply.raw.end();
      };

      deps.runRegistry.setEmitter(runId, (sdkEvent) => {
        if (closed) return;
        const a2aEvent = mapSdkEventToA2A(sdkEvent as SessionEvent, ctx);
        if (!a2aEvent) return;
        writeA2AEvent(reply.raw, eventNameFor(a2aEvent), a2aEvent);
        if (isTerminalA2AEvent(a2aEvent)) close();
      });

      unsubscribe = deps.subscribeToSessionEvents(contextId, (_sessionId, channelId, event) => {
        if (closed || channelId !== contextId) return;

        const terminal = isTerminalSdkEvent(event);
        if (terminal && deps.runRegistry.shouldSuppressCancellationTerminal(runId, contextId, event)) {
          return;
        }
        if (!terminal && !deps.runRegistry.isActiveRun(runId)) {
          return;
        }

        const a2aEvent = mapSdkEventToA2A(event as SessionEvent, ctx);
        if (a2aEvent) {
          writeA2AEvent(reply.raw, eventNameFor(a2aEvent), a2aEvent);
        }
        if (terminal) close();
      });

      request.raw.on('close', () => {
        log.debug('A2A stream client disconnected', { runId });
        close();
      });
    },
  );
}

function writeStreamHeaders(reply: { raw: { writeHead: (status: number, headers: Record<string, string>) => void } }): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function writeA2AEvent(raw: { write: (chunk: string) => void }, eventName: string, payload: unknown): void {
  raw.write(`event: ${eventName}
data: ${JSON.stringify(payload)}

`);
}

function eventNameFor(event: A2AStreamEvent): string {
  if ((event as { kind?: string }).kind === 'status-update') return 'status-update';
  if ((event as { kind?: string }).kind === 'artifact-update') return 'artifact-update';
  return 'task';
}

function isTerminalSdkEvent(event: { type?: string }): boolean {
  return event.type === 'session.idle' || event.type === 'session.error';
}
