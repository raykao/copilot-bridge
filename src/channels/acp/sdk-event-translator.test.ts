import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@github/copilot-sdk';
import { SdkEventTranslator } from './sdk-event-translator.js';

describe('SdkEventTranslator', () => {
  const translateEvent = (event: SessionEvent) => new SdkEventTranslator().translate(event);
  it('maps assistant.streaming_delta to streaming with deltaContent', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'assistant.streaming_delta',
      data: { deltaContent: 'hello' },
    } as unknown as SessionEvent;

    expect(translateEvent(event)).toEqual({ type: 'streaming', content: 'hello' });
  });

  it('maps assistant.message_delta to streaming', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'assistant.message_delta',
      data: { deltaContent: 'world' },
    } as unknown as SessionEvent;

    expect(translateEvent(event)).toEqual({ type: 'streaming', content: 'world' });
  });

  it('returns null for assistant.streaming_delta with empty content', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'assistant.streaming_delta',
      data: { deltaContent: '' },
    } as unknown as SessionEvent;

    expect(translateEvent(event)).toBeNull();
  });

  it('maps session.idle to completed with empty content', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'session.idle',
      data: {},
    } as unknown as SessionEvent;

    expect(translateEvent(event)).toEqual({ type: 'completed', content: '' });
  });

  it('maps agent_idle to completed with empty content', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'agent_idle',
      data: {},
    } as unknown as SessionEvent;

    expect(translateEvent(event)).toEqual({ type: 'completed', content: '' });
  });

  it('maps session.error to error with message', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'session.error',
      data: { message: 'kaboom' },
    } as unknown as SessionEvent;

    expect(translateEvent(event)).toEqual({ type: 'error', content: 'kaboom' });
  });

  it('falls back to data.error for session.error when message missing', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'session.error',
      data: { error: 'oops' },
    } as unknown as SessionEvent;

    expect(translateEvent(event)).toEqual({ type: 'error', content: 'oops' });
  });

  it('uses default text for session.error with no message or error', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'session.error',
      data: {},
    } as unknown as SessionEvent;

    expect(translateEvent(event)).toEqual({ type: 'error', content: 'session error' });
  });

  it('returns null for unmapped event types', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'command.completed',
      data: {},
    } as unknown as SessionEvent;

    expect(translateEvent(event)).toBeNull();
  });

  it('returns null for assistant.message (suppressed in favor of idle)', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'assistant.message',
      data: { content: 'final text' },
    } as unknown as SessionEvent;

    expect(translateEvent(event)).toBeNull();
  });

  it('maps tool.execution_start to tool_start with toolCallId, toolName, and arguments', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'tool.execution_start',
      data: {
        toolCallId: 'tc-001',
        toolName: 'bash',
        arguments: { command: 'ls /tmp' },
      },
    } as unknown as SessionEvent;

    expect(translateEvent(event)).toEqual({
      type: 'tool_start',
      toolCallId: 'tc-001',
      toolName: 'bash',
      arguments: { command: 'ls /tmp' },
    });
  });

  it('defaults arguments to {} when absent in tool.execution_start', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'tool.execution_start',
      data: { toolCallId: 'tc-002', toolName: 'view' },
    } as unknown as SessionEvent;

    const result = translateEvent(event);
    expect(result).not.toBeNull();
    expect((result as { arguments: unknown }).arguments).toEqual({});
  });

  it('maps tool.execution_complete (success) to tool_complete using detailedContent', () => {
    const translator = new SdkEventTranslator();
    translator.translate({
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'tool.execution_start',
      data: { toolCallId: 'tc-001', toolName: 'bash' },
    } as unknown as SessionEvent);
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'tc-001',
        success: true,
        result: { content: 'short', detailedContent: 'full output here' },
      },
    } as unknown as SessionEvent;

    expect(translator.translate(event)).toEqual({
      type: 'tool_complete',
      toolCallId: 'tc-001',
      toolName: 'bash',
      success: true,
      output: 'full output here',
      error: undefined,
    });
  });

  it('falls back to result.content when detailedContent absent in tool.execution_complete', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'tc-003',
        success: true,
        result: { content: 'file contents here' },
      },
    } as unknown as SessionEvent;

    const result = translateEvent(event);
    expect(result).not.toBeNull();
    expect((result as { output: string }).output).toBe('file contents here');
  });

  it('maps tool.execution_complete (failure) with error.message to error field', () => {
    const translator = new SdkEventTranslator();
    translator.translate({
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'tool.execution_start',
      data: { toolCallId: 'tc-004', toolName: 'bash' },
    } as unknown as SessionEvent);
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'tc-004',
        success: false,
        result: { content: '' },
        error: { message: 'command not found' },
      },
    } as unknown as SessionEvent;

    expect(translator.translate(event)).toEqual({
      type: 'tool_complete',
      toolCallId: 'tc-004',
      toolName: 'bash',
      success: false,
      output: '',
      error: 'command not found',
    });
  });

  it('defaults error to "Tool failed" when success=false and no error object', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'tc-005',
        success: false,
      },
    } as unknown as SessionEvent;

    const result = translateEvent(event);
    expect(result).not.toBeNull();
    expect((result as { error: string }).error).toBe('Tool failed');
  });

  it('sets error to undefined on successful tool.execution_complete', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'tool.execution_complete',
      data: {
        toolCallId: 'tc-006',
        success: true,
        result: { content: 'ok' },
      },
    } as unknown as SessionEvent;

    const result = translateEvent(event);
    expect(result).not.toBeNull();
    expect((result as { error: unknown }).error).toBeUndefined();
  });
});
