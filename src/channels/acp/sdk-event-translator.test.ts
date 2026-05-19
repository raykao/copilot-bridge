import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@github/copilot-sdk';
import { translateSdkEvent } from './sdk-event-translator.js';

describe('translateSdkEvent', () => {
  it('maps assistant.streaming_delta to streaming with deltaContent', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'assistant.streaming_delta',
      data: { deltaContent: 'hello' },
    } as unknown as SessionEvent;

    expect(translateSdkEvent(event)).toEqual({ type: 'streaming', content: 'hello' });
  });

  it('maps assistant.message_delta to streaming', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'assistant.message_delta',
      data: { deltaContent: 'world' },
    } as unknown as SessionEvent;

    expect(translateSdkEvent(event)).toEqual({ type: 'streaming', content: 'world' });
  });

  it('returns null for assistant.streaming_delta with empty content', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'assistant.streaming_delta',
      data: { deltaContent: '' },
    } as unknown as SessionEvent;

    expect(translateSdkEvent(event)).toBeNull();
  });

  it('maps session.idle to completed with empty content', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'session.idle',
      data: {},
    } as unknown as SessionEvent;

    expect(translateSdkEvent(event)).toEqual({ type: 'completed', content: '' });
  });

  it('maps agent_idle to completed with empty content', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'agent_idle',
      data: {},
    } as unknown as SessionEvent;

    expect(translateSdkEvent(event)).toEqual({ type: 'completed', content: '' });
  });

  it('maps session.error to error with message', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'session.error',
      data: { message: 'kaboom' },
    } as unknown as SessionEvent;

    expect(translateSdkEvent(event)).toEqual({ type: 'error', content: 'kaboom' });
  });

  it('falls back to data.error for session.error when message missing', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'session.error',
      data: { error: 'oops' },
    } as unknown as SessionEvent;

    expect(translateSdkEvent(event)).toEqual({ type: 'error', content: 'oops' });
  });

  it('uses default text for session.error with no message or error', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'session.error',
      data: {},
    } as unknown as SessionEvent;

    expect(translateSdkEvent(event)).toEqual({ type: 'error', content: 'session error' });
  });

  it('returns null for unmapped event types', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'command.completed',
      data: {},
    } as unknown as SessionEvent;

    expect(translateSdkEvent(event)).toBeNull();
  });

  it('returns null for assistant.message (suppressed in favor of idle)', () => {
    const event = {
      id: 'a',
      timestamp: '2026-01-01T00:00:00Z',
      parentId: null,
      type: 'assistant.message',
      data: { content: 'final text' },
    } as unknown as SessionEvent;

    expect(translateSdkEvent(event)).toBeNull();
  });
});
