import type { SessionEvent } from '@github/copilot-sdk';
import type {
  A2AStreamEvent,
  A2ATaskStatusUpdateEvent,
  A2ATaskArtifactUpdateEvent,
} from '../a2a-types.js';

export interface MapContext {
  taskId: string;
  contextId: string;
}

export function mapSdkEventToA2A(event: SessionEvent, ctx: MapContext): A2AStreamEvent | undefined {
  const type = getEventType(event);
  const data = getEventData(event);

  switch (type) {
    case 'assistant.message_delta':
      return artifactUpdate(ctx, readString(data, 'deltaContent'), true, false);
    case 'assistant.message':
      return artifactUpdate(ctx, readString(data, 'content'), false, true);
    case 'run.awaiting':
      return {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        kind: 'status-update',
        final: false,
        status: {
          state: 'input-required',
          message: {
            role: 'agent',
            messageId: `${ctx.taskId}-permreq-${Date.now()}`,
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            parts: [{ kind: 'text', text: `Permission required: ${readString(data, 'tool', 'toolName', 'name') || 'unknown'}` }],
          },
        },
      } satisfies A2ATaskStatusUpdateEvent;
    case 'bridge.permission_request':
      return {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        kind: 'status-update',
        final: false,
        status: {
          state: 'input-required',
          message: {
            role: 'agent',
            messageId: `${ctx.taskId}-permreq-${Date.now()}`,
            taskId: ctx.taskId,
            contextId: ctx.contextId,
            parts: [{ kind: 'text', text: `Permission required: ${readString(data, 'toolName', 'tool', 'name') || 'unknown'}` }],
          },
        },
      } satisfies A2ATaskStatusUpdateEvent;
    case 'session.idle':
      return {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        kind: 'status-update',
        final: true,
        status: { state: 'completed' },
      } satisfies A2ATaskStatusUpdateEvent;
    case 'session.error': {
      const error = readString(data, 'message', 'error');
      const mapped: A2ATaskStatusUpdateEvent = {
        taskId: ctx.taskId,
        contextId: ctx.contextId,
        kind: 'status-update',
        final: true,
        status: { state: 'failed' },
      };
      if (error) {
        mapped.status.message = {
          role: 'agent',
          messageId: `${ctx.taskId}-error`,
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          parts: [{ kind: 'text', text: error }],
        };
      }
      return mapped;
    }
    default:
      return undefined;
  }
}

export function isTerminalA2AEvent(event: A2AStreamEvent): boolean {
  return event.kind === 'status-update' && event.final === true;
}

function artifactUpdate(ctx: MapContext, text: string, append: boolean, lastChunk: boolean): A2ATaskArtifactUpdateEvent {
  return {
    taskId: ctx.taskId,
    contextId: ctx.contextId,
    kind: 'artifact-update',
    append,
    lastChunk,
    artifact: {
      artifactId: ctx.taskId,
      parts: [{ kind: 'text', text }],
    },
  };
}

function getEventType(event: SessionEvent): string {
  return readEventString(event, 'type');
}

function getEventData(event: SessionEvent): Record<string, unknown> {
  const data = (event as { data?: unknown }).data;
  return isRecord(data) ? data : {};
}

function readEventString(event: SessionEvent, key: string): string {
  const value = (event as unknown as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

function readString(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
