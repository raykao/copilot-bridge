import type { SessionEvent } from '@github/copilot-sdk';

export type SimplifiedUpdate =
  | { type: 'streaming'; content: string }
  | { type: 'completed'; content: string }
  | { type: 'error'; content: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: 'tool_complete'; toolCallId: string; toolName: string; success: boolean; output: string; error?: string };

export class SdkEventTranslator {
  private readonly toolNames = new Map<string, string>();

  translate(event: SessionEvent): SimplifiedUpdate | null {
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
    if (t === 'tool.execution_start') {
      const d = (event as { data?: { toolCallId?: unknown; toolName?: unknown; arguments?: unknown } }).data ?? {};
      const toolCallId = typeof d.toolCallId === 'string' ? d.toolCallId : `tool-${Date.now()}`;
      const toolName = typeof d.toolName === 'string' ? d.toolName : 'unknown';
      const args =
        d.arguments !== null &&
        d.arguments !== undefined &&
        typeof d.arguments === 'object' &&
        !Array.isArray(d.arguments)
          ? (d.arguments as Record<string, unknown>)
          : {};
      if (toolCallId && toolName !== 'unknown') {
        this.toolNames.set(toolCallId, toolName);
      }
      return { type: 'tool_start', toolCallId, toolName, arguments: args };
    }
    if (t === 'tool.execution_complete') {
      const d = (event as { data?: { toolCallId?: unknown; success?: unknown; result?: unknown; error?: unknown } }).data ?? {};
      const toolCallId = typeof d.toolCallId === 'string' ? d.toolCallId : `tool-${Date.now()}`;
      const toolName = this.toolNames.get(toolCallId) ?? 'unknown';
      this.toolNames.delete(toolCallId);
      const success = d.success !== false;
      const result =
        d.result !== null &&
        d.result !== undefined &&
        typeof d.result === 'object' &&
        !Array.isArray(d.result)
          ? (d.result as Record<string, unknown>)
          : {};
      const output =
        typeof result.detailedContent === 'string'
          ? result.detailedContent
          : typeof result.content === 'string'
            ? result.content
            : '';
      const errObj =
        d.error !== null &&
        d.error !== undefined &&
        typeof d.error === 'object' &&
        !Array.isArray(d.error)
          ? (d.error as Record<string, unknown>)
          : null;
      const error: string | undefined = !success
        ? typeof errObj?.message === 'string'
          ? errObj.message
          : 'Tool failed'
        : undefined;
      return { type: 'tool_complete', toolCallId, toolName, success, output, error };
    }
    return null;
  }
}
