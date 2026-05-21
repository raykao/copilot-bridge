# a9k.10 Bridge Task: Extend sdk-event-translator for Tool Events

## Context

File: `src/channels/acp/sdk-event-translator.ts`

This file translates raw Copilot SDK `SessionEvent` objects into a
`SimplifiedUpdate` union that is spread into `session/update` JSON-RPC
notifications sent to the kanban ACP WebSocket client.

Currently the translator handles only `streaming`, `completed`, and `error`
variants. SDK tool events (`tool.execution_start`, `tool.execution_complete`)
are silently dropped, so tool activity never reaches kanban.

`connection-handler.ts` calls `translateSdkEvent(event)` and, if non-null,
sends the result as `{ jsonrpc: '2.0', method: 'session/update', params: { sessionId, ...translated } }`.
No changes are needed in connection-handler.ts.

---

## Task: extend SimplifiedUpdate and translateSdkEvent

### Files to read (in full, before writing)

1. `src/channels/acp/sdk-event-translator.ts` - full file (36 lines)
2. `src/channels/acp/sdk-event-translator.test.ts` - full file (125 lines)

### Files to modify

1. `src/channels/acp/sdk-event-translator.ts`
2. `src/channels/acp/sdk-event-translator.test.ts`

---

## Exact changes to sdk-event-translator.ts

### Step 1 - Add two new variants to SimplifiedUpdate

Replace the existing type:
```ts
export type SimplifiedUpdate =
  | { type: 'streaming'; content: string }
  | { type: 'completed'; content: string }
  | { type: 'error'; content: string };
```

With:
```ts
export type SimplifiedUpdate =
  | { type: 'streaming'; content: string }
  | { type: 'completed'; content: string }
  | { type: 'error'; content: string }
  | { type: 'tool_start'; toolCallId: string; toolName: string; arguments: Record<string, unknown> }
  | { type: 'tool_complete'; toolCallId: string; toolName: string; success: boolean; output: string; error?: string };
```

### Step 2 - Handle tool.execution_start

Add this block inside `translateSdkEvent()` BEFORE the final `return null`:

```ts
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
  return { type: 'tool_start', toolCallId, toolName, arguments: args };
}
```

### Step 3 - Handle tool.execution_complete

Add this block immediately after the tool.execution_start block:

```ts
if (t === 'tool.execution_complete') {
  const d = (event as { data?: { toolCallId?: unknown; toolName?: unknown; success?: unknown; result?: unknown; error?: unknown } }).data ?? {};
  const toolCallId = typeof d.toolCallId === 'string' ? d.toolCallId : `tool-${Date.now()}`;
  const toolName = typeof d.toolName === 'string' ? d.toolName : 'unknown';
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
```

---

## Exact new tests in sdk-event-translator.test.ts

Add these 7 tests inside the existing `describe('translateSdkEvent', ...)` block,
after the last existing test ('returns null for assistant.message ...').

### Test 1: tool.execution_start - happy path
```ts
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

  expect(translateSdkEvent(event)).toEqual({
    type: 'tool_start',
    toolCallId: 'tc-001',
    toolName: 'bash',
    arguments: { command: 'ls /tmp' },
  });
});
```

### Test 2: tool.execution_start - missing arguments defaults to {}
```ts
it('defaults arguments to {} when absent in tool.execution_start', () => {
  const event = {
    id: 'a',
    timestamp: '2026-01-01T00:00:00Z',
    parentId: null,
    type: 'tool.execution_start',
    data: { toolCallId: 'tc-002', toolName: 'view' },
  } as unknown as SessionEvent;

  const result = translateSdkEvent(event);
  expect(result).not.toBeNull();
  expect((result as { arguments: unknown }).arguments).toEqual({});
});
```

### Test 3: tool.execution_complete - success path with detailedContent preferred
```ts
it('maps tool.execution_complete (success) to tool_complete using detailedContent', () => {
  const event = {
    id: 'a',
    timestamp: '2026-01-01T00:00:00Z',
    parentId: null,
    type: 'tool.execution_complete',
    data: {
      toolCallId: 'tc-001',
      toolName: 'bash',
      success: true,
      result: { content: 'short', detailedContent: 'full output here' },
    },
  } as unknown as SessionEvent;

  expect(translateSdkEvent(event)).toEqual({
    type: 'tool_complete',
    toolCallId: 'tc-001',
    toolName: 'bash',
    success: true,
    output: 'full output here',
    error: undefined,
  });
});
```

### Test 4: tool.execution_complete - falls back to content when no detailedContent
```ts
it('falls back to result.content when detailedContent absent in tool.execution_complete', () => {
  const event = {
    id: 'a',
    timestamp: '2026-01-01T00:00:00Z',
    parentId: null,
    type: 'tool.execution_complete',
    data: {
      toolCallId: 'tc-003',
      toolName: 'view',
      success: true,
      result: { content: 'file contents here' },
    },
  } as unknown as SessionEvent;

  const result = translateSdkEvent(event);
  expect(result).not.toBeNull();
  expect((result as { output: string }).output).toBe('file contents here');
});
```

### Test 5: tool.execution_complete - failure with error.message
```ts
it('maps tool.execution_complete (failure) with error.message to error field', () => {
  const event = {
    id: 'a',
    timestamp: '2026-01-01T00:00:00Z',
    parentId: null,
    type: 'tool.execution_complete',
    data: {
      toolCallId: 'tc-004',
      toolName: 'bash',
      success: false,
      result: { content: '' },
      error: { message: 'command not found' },
    },
  } as unknown as SessionEvent;

  expect(translateSdkEvent(event)).toEqual({
    type: 'tool_complete',
    toolCallId: 'tc-004',
    toolName: 'bash',
    success: false,
    output: '',
    error: 'command not found',
  });
});
```

### Test 6: tool.execution_complete - failure with no error object defaults
```ts
it('defaults error to "Tool failed" when success=false and no error object', () => {
  const event = {
    id: 'a',
    timestamp: '2026-01-01T00:00:00Z',
    parentId: null,
    type: 'tool.execution_complete',
    data: {
      toolCallId: 'tc-005',
      toolName: 'bash',
      success: false,
    },
  } as unknown as SessionEvent;

  const result = translateSdkEvent(event);
  expect(result).not.toBeNull();
  expect((result as { error: string }).error).toBe('Tool failed');
});
```

### Test 7: tool.execution_complete - success produces no error field
```ts
it('sets error to undefined on successful tool.execution_complete', () => {
  const event = {
    id: 'a',
    timestamp: '2026-01-01T00:00:00Z',
    parentId: null,
    type: 'tool.execution_complete',
    data: {
      toolCallId: 'tc-006',
      toolName: 'view',
      success: true,
      result: { content: 'ok' },
    },
  } as unknown as SessionEvent;

  const result = translateSdkEvent(event);
  expect(result).not.toBeNull();
  expect((result as { error: unknown }).error).toBeUndefined();
});
```

---

## Done criteria

Run from the worktree root (`workbench/impl/bridge-a9k-10`):
```
npx tsc --noEmit
npx vitest run src/channels/acp/sdk-event-translator.test.ts
```

Both must exit 0 with no errors. The test run must show exactly 7 new tests (16 total in that file).
Run `npx vitest run` (all tests) and confirm still 805 passing.

---

## Commit

```
git add src/channels/acp/sdk-event-translator.ts src/channels/acp/sdk-event-translator.test.ts
git commit -m "feat(acp): forward tool.execution_start/complete events through session/update"
```

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>

---

ESCALATION RULE: If any requirement in this spec is ambiguous, contradictory, or covers a situation not described here, STOP. Do NOT guess or infer intent. Ask the orchestrator a specific question: "The spec says X but I encountered Y -- should I do A or B?" Wait for the answer before writing code for that part.
