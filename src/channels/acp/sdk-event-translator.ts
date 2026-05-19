import type { SessionEvent } from '@github/copilot-sdk';

export type SimplifiedUpdate =
  | { type: 'streaming'; content: string }
  | { type: 'completed'; content: string }
  | { type: 'error'; content: string };

export function translateSdkEvent(event: SessionEvent): SimplifiedUpdate | null {
  const t: string = event.type;
  if (t === 'assistant.streaming_delta' || t === 'assistant.message_delta') {
    const data = (event as { data?: { deltaContent?: unknown; content?: unknown } }).data ?? {};
    const text =
      typeof data.deltaContent === 'string' ? data.deltaContent :
      typeof data.content === 'string' ? data.content :
      '';
    if (!text) return null;
    return { type: 'streaming', content: text };
  }
  if (t === 'assistant.message') {
    const data = (event as { data?: { content?: unknown } }).data ?? {};
    const text = typeof data.content === 'string' ? data.content : '';
    if (!text) return null;
    return null;
  }
  if (t === 'session.idle' || t === 'agent_idle') {
    return { type: 'completed', content: '' };
  }
  if (t === 'session.error') {
    const data = (event as { data?: { message?: unknown; error?: unknown } }).data ?? {};
    const msg =
      typeof data.message === 'string' ? data.message :
      typeof data.error === 'string' ? data.error :
      'session error';
    return { type: 'error', content: msg };
  }
  return null;
}
