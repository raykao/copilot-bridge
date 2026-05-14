import type { SessionEvent } from '@github/copilot-sdk';
import { describe, expect, it } from 'vitest';
import type { A2AStreamEvent, A2ATaskArtifactUpdateEvent, A2ATaskStatusUpdateEvent } from '../a2a-types.js';
import { isTerminalA2AEvent, mapSdkEventToA2A, type MapContext } from './a2a-events.js';

const ctx: MapContext = { taskId: 'task-123', contextId: 'context-123' };

const sdkEvent = (type: string, data: Record<string, unknown> = {}, extras: Record<string, unknown> = {}): SessionEvent => ({
  type,
  data,
  id: `${type}-id`,
  timestamp: '2026-01-01T00:00:00.000Z',
  parentId: null,
  ...extras,
} as unknown as SessionEvent);

const expectContext = (event: A2AStreamEvent | undefined): void => {
  expect(event).toMatchObject({ taskId: ctx.taskId, contextId: ctx.contextId });
};

describe('mapSdkEventToA2A', () => {
  it('maps assistant.message_delta to an append artifact update', () => {
    const event = mapSdkEventToA2A(sdkEvent('assistant.message_delta', { deltaContent: 'hel' }), ctx) as A2ATaskArtifactUpdateEvent;

    expect(event).toMatchObject({
      kind: 'artifact-update',
      taskId: 'task-123',
      contextId: 'context-123',
      append: true,
      lastChunk: false,
      artifact: {
        artifactId: 'task-123',
        parts: [{ kind: 'text', text: 'hel' }],
      },
    });
    expectContext(event);
  });

  it('maps assistant.message to a final artifact update', () => {
    const event = mapSdkEventToA2A(sdkEvent('assistant.message', { content: 'hello' }), ctx) as A2ATaskArtifactUpdateEvent;

    expect(event).toMatchObject({
      kind: 'artifact-update',
      append: false,
      lastChunk: true,
      artifact: {
        artifactId: 'task-123',
        parts: [{ kind: 'text', text: 'hello' }],
      },
    });
    expectContext(event);
  });

  it('maps bridge.permission_request to a non-final input-required status update', () => {
    const event = mapSdkEventToA2A(sdkEvent('bridge.permission_request', { toolName: 'bash' }), ctx) as A2ATaskStatusUpdateEvent;

    expect(event.kind).toBe('status-update');
    expect(event.status.state).toBe('input-required');
    expect(event.final).toBe(false);
    expect(event.status.message?.messageId).toMatch(/^task-123-permreq-/);
    expect(event.status.message?.parts[0]?.text).toBe('Permission required: bash');
    expectContext(event);
  });

  it('maps run.awaiting to a non-final input-required status update', () => {
    const event = mapSdkEventToA2A(sdkEvent('run.awaiting', { run_id: 'task-1', tool: 'shell', detail: '...' }), ctx) as A2ATaskStatusUpdateEvent;

    expect(event.kind).toBe('status-update');
    expect(event.final).toBe(false);
    expect(event.status.state).toBe('input-required');
    expect(event.status.message?.parts[0]?.text).toContain('shell');
    expectContext(event);
  });

  it('maps session.idle to a final completed status update', () => {
    const event = mapSdkEventToA2A(sdkEvent('session.idle'), ctx) as A2ATaskStatusUpdateEvent;

    expect(event).toMatchObject({
      kind: 'status-update',
      taskId: 'task-123',
      contextId: 'context-123',
      final: true,
      status: { state: 'completed' },
    });
  });

  it('maps session.error to a final failed status update with error text when present', () => {
    const event = mapSdkEventToA2A(sdkEvent('session.error', { message: 'boom' }), ctx) as A2ATaskStatusUpdateEvent;

    expect(event.kind).toBe('status-update');
    expect(event.status.state).toBe('failed');
    expect(event.final).toBe(true);
    expect(event.status.message?.parts[0]?.text).toContain('boom');
    expectContext(event);
  });

  it('returns undefined for unknown SDK event types', () => {
    expect(mapSdkEventToA2A(sdkEvent('foo'), ctx)).toBeUndefined();
  });
});

describe('isTerminalA2AEvent', () => {
  it('returns true for final status updates and false for artifact and non-final status updates', () => {
    const finalStatus = mapSdkEventToA2A(sdkEvent('session.idle'), ctx);
    const artifact = mapSdkEventToA2A(sdkEvent('assistant.message_delta', { deltaContent: 'hel' }), ctx);
    const nonFinalStatus = mapSdkEventToA2A(sdkEvent('bridge.permission_request', { name: 'bash' }), ctx);

    expect(finalStatus && isTerminalA2AEvent(finalStatus)).toBe(true);
    expect(artifact && isTerminalA2AEvent(artifact)).toBe(false);
    expect(nonFinalStatus && isTerminalA2AEvent(nonFinalStatus)).toBe(false);
  });
});
