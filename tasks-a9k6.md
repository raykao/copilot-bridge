# Task a9k.6 - bridge permission policies: auto-evaluate before forwarding to ACP client + populate pendingPermissions[]

## Goal

Two behaviors:

1. **Config-policy pre-check**: In `makePermissionHandler()` inside `AcpConnectionHandler`, before forwarding a permission request to the ACP WS client, call `evaluateConfigPermissions()` from `src/config.ts`. If it returns `'allow'` or `'deny'`, resolve immediately (no WS message sent). Only forward to the client when the result is `null` (no rule matched).

2. **pendingPermissions[] in SessionState**: When a request IS forwarded to the ACP client (parked in `pendingPermissions` Map), add a `PendingPermission` entry to bridge-side session state so that `session/get` and `session/state_changed` reflect the actual outstanding requests. Remove on resolution.

## Files to read BEFORE writing any code

1. `src/channels/acp/connection-handler.ts` - full file (501 lines), focus on `makePermissionHandler()`, `handlePermissionResponse()`, `AcpConnectionHandler` class shape
2. `src/core/bridge.ts` - focus on `buildSessionState()` (line 263), `notifySessionSubscribers()` (line 253), private fields (lines 35-45), `setSessionStatus()` (line 247)
3. `src/core/session-types.ts` - `PendingPermission` interface, `SessionState` interface
4. `src/config.ts` - `evaluateConfigPermissions()` function signature (line 961-966). Note it takes `(request, channelWorkingDirectory, workspaceAllowPaths?, isAdmin?)` and returns `'allow' | 'deny' | null`
5. `src/channels/acp/connection-handler.test.ts` - lines 1-120 (fake bridge shape, test patterns), lines 347-452 (existing permission tests)

## Files to create or modify

1. `src/core/bridge.ts` (MODIFY)
2. `src/channels/acp/connection-handler.ts` (MODIFY)
3. `src/channels/acp/connection-handler.test.ts` (MODIFY - add new tests)

---

## File 1: src/core/bridge.ts (MODIFY)

### 1a. Add sessionPendingPermissions private field

In the `CopilotBridge` class, find the block of private readonly fields that includes `sessionStatuses`, `sessionUpdatedAt`, `sessionSubscribers` (around lines 38-41). Add a new field after them:

```typescript
private readonly sessionPendingPermissions = new Map<string, Map<string, import('./session-types.js').PendingPermission>>();
```

Note: `PendingPermission` is already imported via `SessionState` type. Check actual imports at top of file. If `PendingPermission` is not explicitly imported, add it:

```typescript
import type { SessionStatus, SessionState, PendingPermission } from './session-types.js';
```

(Replace the existing import that likely only has `SessionStatus` and `SessionState`.)

### 1b. Add addPendingPermission method

Add this public method after `unsubscribeFromSession`:

```typescript
addPendingPermission(sessionId: string, perm: PendingPermission): void {
  let map = this.sessionPendingPermissions.get(sessionId);
  if (!map) {
    map = new Map<string, PendingPermission>();
    this.sessionPendingPermissions.set(sessionId, map);
  }
  map.set(perm.requestId, perm);
  this.notifySessionSubscribers(sessionId);
}
```

### 1c. Add removePendingPermission method

Add this public method after `addPendingPermission`:

```typescript
removePendingPermission(sessionId: string, requestId: string): void {
  const map = this.sessionPendingPermissions.get(sessionId);
  if (!map) return;
  map.delete(requestId);
  if (map.size === 0) this.sessionPendingPermissions.delete(sessionId);
  this.notifySessionSubscribers(sessionId);
}
```

### 1d. Update buildSessionState to use real pendingPermissions

Find `buildSessionState` (returns a `SessionState | null`). It currently has:
```typescript
pendingPermissions: [],
```

Change that line to:
```typescript
pendingPermissions: Array.from(this.sessionPendingPermissions.get(id)?.values() ?? []),
```

Apply the same change in `getAllSessionStates` where `pendingPermissions: []` also appears (there are two occurrences total in bridge.ts).

---

## File 2: src/channels/acp/connection-handler.ts (MODIFY)

### 2a. Import evaluateConfigPermissions

At the top of the file, after existing imports, add:

```typescript
import { evaluateConfigPermissions } from '../../config.js';
```

### 2b. Update makePermissionHandler to pre-check config policies

The current `makePermissionHandler` method (lines 285-310) is:

```typescript
private makePermissionHandler(): (
  request: PermissionRequest,
  invocation: { sessionId: string },
) => Promise<PermissionRequestResult> {
  return async (request, invocation) => {
    const requestId = randomUUID();
    const params = {
      sessionId: invocation.sessionId,
      kind: request.kind,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      request,
    } satisfies SessionRequestPermissionParams;

    this.send({
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/request_permission',
      params,
    });
    log.info(`request_permission_sent acpSessionId=${invocation.sessionId} wsReqId=${requestId} kind=${request.kind}${request.toolCallId ? ` toolCallId=${request.toolCallId}` : ''}`);

    return new Promise<PermissionRequestResult>((resolve, reject) => {
      this.pendingPermissions.set(requestId, { resolve, reject });
    });
  };
}
```

Replace it entirely with:

```typescript
private makePermissionHandler(): (
  request: PermissionRequest,
  invocation: { sessionId: string },
) => Promise<PermissionRequestResult> {
  return async (request, invocation) => {
    const workingDirectory = this.botCfg.workingDirectory ?? process.cwd();
    const policyDecision = evaluateConfigPermissions(request as Record<string, unknown> & { kind: string }, workingDirectory);

    if (policyDecision === 'allow') {
      log.info(`request_permission_policy_allow acpSessionId=${invocation.sessionId} kind=${request.kind}`);
      return { kind: 'approve-once' };
    }

    if (policyDecision === 'deny') {
      log.info(`request_permission_policy_deny acpSessionId=${invocation.sessionId} kind=${request.kind}`);
      return { kind: 'reject' };
    }

    const requestId = randomUUID();
    const params = {
      sessionId: invocation.sessionId,
      kind: request.kind,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      request,
    } satisfies SessionRequestPermissionParams;

    this.bridge.addPendingPermission(invocation.sessionId, {
      requestId,
      kind: request.kind,
      ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
      requestedAt: new Date().toISOString(),
    });

    this.send({
      jsonrpc: '2.0',
      id: requestId,
      method: 'session/request_permission',
      params,
    });
    log.info(`request_permission_sent acpSessionId=${invocation.sessionId} wsReqId=${requestId} kind=${request.kind}${request.toolCallId ? ` toolCallId=${request.toolCallId}` : ''}`);

    return new Promise<PermissionRequestResult>((resolve, reject) => {
      this.pendingPermissions.set(requestId, {
        resolve,
        reject,
        sessionId: invocation.sessionId,
      });
    });
  };
}
```

### 2c. Update PendingPermission internal interface

At the top of the file (line 44), the internal `PendingPermission` interface is:

```typescript
interface PendingPermission { resolve: (result: PermissionRequestResult) => void; reject: (err: Error) => void; }
```

Change it to:

```typescript
interface PendingPermission { resolve: (result: PermissionRequestResult) => void; reject: (err: Error) => void; sessionId: string; }
```

Note: this is the file-LOCAL `PendingPermission` interface (not the one from session-types.ts). Keep it as-is with the added `sessionId` field.

### 2d. Update handlePermissionResponse to remove from bridge state

In `handlePermissionResponse` (lines 135-153), after `this.pendingPermissions.delete(String(msg.id))`, add:

```typescript
const sessionId = pending.sessionId;
this.bridge.removePendingPermission(sessionId, String(msg.id));
```

The full updated `handlePermissionResponse` should be:

```typescript
private handlePermissionResponse(msg: JsonRpcResponse): void {
  const pending = this.pendingPermissions.get(String(msg.id));
  if (!pending) {
    log.warn('Unknown permission response', { id: msg.id });
    return;
  }

  this.pendingPermissions.delete(String(msg.id));
  const sessionId = pending.sessionId;
  this.bridge.removePendingPermission(sessionId, String(msg.id));
  const rawDecision = msg.result !== undefined
    ? ((msg.result as SessionRequestPermissionResult)?.decision ?? 'unknown')
    : 'error';
  const decision = rawDecision === 'deny' ? 'reject' : rawDecision;
  log.info(`permission_resume_received wsReqId=${msg.id} decision=${decision}`);
  if (msg.result !== undefined) {
    pending.resolve(this.toPermissionResult(msg.result as SessionRequestPermissionResult));
  } else if (msg.error) {
    pending.reject(new Error(msg.error.message));
  }
}
```

### 2e. Update bridge interface type referenced in test/fake

The `bridge` field type in `AcpConnectionHandler` is typed as `CopilotBridge`. The `CopilotBridge` class now has `addPendingPermission` and `removePendingPermission`. The fake bridge in tests needs these methods added. But this is handled in File 3 (test updates).

---

## File 3: src/channels/acp/connection-handler.test.ts (MODIFY)

### 3a. Update bridgeWithSession helper

In `bridgeWithSession` (lines 64-103), add two new vi.fn() mocks for the new bridge methods.

Add after `const setSessionStatus = vi.fn();`:
```typescript
const addPendingPermission = vi.fn();
const removePendingPermission = vi.fn();
```

Add them to the return type interface (add to the return object and the destructured return):
```typescript
addPendingPermission: ReturnType<typeof vi.fn>;
removePendingPermission: ReturnType<typeof vi.fn>;
```

And include them in the fake bridge object:
```typescript
bridge: { ..., addPendingPermission, removePendingPermission } as unknown as CopilotBridge,
```

And in the return value:
```typescript
return {
  bridge: ...,
  ...
  addPendingPermission,
  removePendingPermission,
};
```

### 3b. Add new test cases for config policy pre-check

Add a new `describe` block after the existing permission tests (after line ~452). Search for the end of the existing permission describe block.

The new describe block must be added at module level (not nested inside an existing describe).

```typescript
describe('AcpConnectionHandler - permission policy pre-check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auto-allows a request when evaluateConfigPermissions returns allow', async () => {
    const sent: SentMessage[] = [];
    const session = fakeSession();
    let capturedHandler: ((request: { kind: string; fullCommandText?: string }, invocation: { sessionId: string }) => Promise<PermissionRequestResult>) | undefined;

    const { bridge } = bridgeWithSession(session);
    (bridge.getOrCreateBotSession as ReturnType<typeof vi.fn>).mockImplementation(
      async (_wd: string, _agent: string | undefined, opts: BotSessionOptions) => {
        capturedHandler = opts.onPermissionRequest as typeof capturedHandler;
        return session as unknown as CopilotSession;
      },
    );
    (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(defaultState());

    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} }));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'new', method: 'session/new', params: {} }));

    // Simulate a permission request with a kind that evaluateConfigPermissions allows
    // We need to mock evaluateConfigPermissions. Use vi.mock at module level OR
    // just test with a 'read' request inside the working directory.
    // Since botConfig().workingDirectory = '/test/workspace', a read inside it auto-allows.
    const result = await capturedHandler!({ kind: 'read', path: '/test/workspace/file.ts' } as { kind: string; path?: string }, { sessionId: 's1' });

    expect(result).toEqual({ kind: 'approve-once' });
    expect(sent.some((m) => m.method === 'session/request_permission')).toBe(false);
    expect((bridge.addPendingPermission as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('auto-denies a request when evaluateConfigPermissions returns deny via config deny rule', async () => {
    const sent: SentMessage[] = [];
    const session = fakeSession();
    let capturedHandler: ((request: { kind: string; fullCommandText?: string }, invocation: { sessionId: string }) => Promise<PermissionRequestResult>) | undefined;

    // Use vi.mock to intercept evaluateConfigPermissions - but since we can't easily
    // inject a deny rule without modifying config, test by checking that when policy
    // returns null the request IS forwarded (proving the pre-check path works).
    // For the deny test: use a hardcoded deny - 'shell' with 'rm -rf /' is always denied.
    const { bridge } = bridgeWithSession(session);
    (bridge.getOrCreateBotSession as ReturnType<typeof vi.fn>).mockImplementation(
      async (_wd: string, _agent: string | undefined, opts: BotSessionOptions) => {
        capturedHandler = opts.onPermissionRequest as typeof capturedHandler;
        return session as unknown as CopilotSession;
      },
    );
    (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(defaultState());

    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} }));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'new', method: 'session/new', params: {} }));

    // Hardcoded deny: isHardDeny('shell', 'rm -rf /') = true
    const result = await capturedHandler!({ kind: 'shell', fullCommandText: 'rm -rf /' } as { kind: string; fullCommandText?: string }, { sessionId: 's1' });

    expect(result).toEqual({ kind: 'reject' });
    expect(sent.some((m) => m.method === 'session/request_permission')).toBe(false);
    expect((bridge.addPendingPermission as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('forwards to client and calls addPendingPermission when policy returns null', async () => {
    const sent: SentMessage[] = [];
    const session = fakeSession();
    let capturedHandler: ((request: { kind: string; fullCommandText?: string }, invocation: { sessionId: string }) => Promise<PermissionRequestResult>) | undefined;

    const { bridge } = bridgeWithSession(session);
    (bridge.getOrCreateBotSession as ReturnType<typeof vi.fn>).mockImplementation(
      async (_wd: string, _agent: string | undefined, opts: BotSessionOptions) => {
        capturedHandler = opts.onPermissionRequest as typeof capturedHandler;
        return session as unknown as CopilotSession;
      },
    );
    (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(defaultState());

    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} }));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'new', method: 'session/new', params: {} }));

    // A shell request with no config rules → policy returns null → forward to client
    const permissionPromise = capturedHandler!({ kind: 'shell', fullCommandText: 'echo hello' } as { kind: string; fullCommandText?: string }, { sessionId: 's1' });

    const permRequest = sent.find((m) => m.method === 'session/request_permission');
    expect(permRequest).toBeDefined();
    expect((bridge.addPendingPermission as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((bridge.addPendingPermission as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('s1');
    expect((bridge.addPendingPermission as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({ kind: 'shell' });

    // Resolve via client response
    const requestId = permRequest!.id as string;
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: requestId, result: { decision: 'allow' } }));

    await expect(permissionPromise).resolves.toEqual({ kind: 'approve-once' });
    expect((bridge.removePendingPermission as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    expect((bridge.removePendingPermission as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(['s1', requestId]);
  });
});
```

### 3c. Add test for pendingPermissions in SessionState via bridge

Add a second new describe block:

```typescript
describe('AcpConnectionHandler - pendingPermissions in session state', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('session/get returns pendingPermissions from bridge state', async () => {
    const sent: SentMessage[] = [];
    const session = fakeSession();
    const { bridge } = bridgeWithSession(session);

    const pendingPerm = {
      requestId: 'req-abc',
      kind: 'shell',
      requestedAt: '2026-05-20T20:00:00.000Z',
    };
    (bridge.getSessionState as ReturnType<typeof vi.fn>).mockReturnValue(
      defaultState({ pendingPermissions: [pendingPerm] }),
    );

    const handler = new AcpConnectionHandler(botConfig(), bridge, (msg) => sent.push(msg as SentMessage));
    await handler.handle(JSON.stringify({ jsonrpc: '2.0', id: 'g1', method: 'session/get', params: { sessionId: 's1' } }));

    const resp = sent.find((m) => (m as { id?: string }).id === 'g1');
    expect(resp).toBeDefined();
    expect((resp as { result?: { pendingPermissions?: unknown[] } }).result?.pendingPermissions).toEqual([pendingPerm]);
  });
});
```

---

## Done criteria

Run from the worktree at `/home/raykao/.copilot-bridge/workspaces/bob/workbench/impl/bridge-a9k-6`:

```bash
npx tsc --noEmit
npm test -- --run
```

Expected:
- `npx tsc --noEmit` exits 0
- `npm test -- --run` shows at least **805 passed** (800 baseline + 5 new tests)

## Commit message

```
feat(acp): a9k.6 - bridge permission policy pre-check + pendingPermissions[] in SessionState

- evaluateConfigPermissions() checked before forwarding to ACP client
  * 'allow' -> resolve immediately with approve-once (no WS message)
  * 'deny' -> resolve immediately with reject (no WS message)
  * null -> forward to client as before
- CopilotBridge.addPendingPermission() + removePendingPermission() track outstanding
  permissions per session; notifySessionSubscribers() fires on each change
- buildSessionState() + getAllSessionStates() now return real pendingPermissions[]
- handlePermissionResponse() calls removePendingPermission() on resolution
- 5 new tests: policy-allow, policy-deny (hardcoded), null-forward+bridge-tracking,
  pendingPermissions in session/get response

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>
```

---

## ESCALATION RULE

If any requirement in this spec is ambiguous, contradictory, or covers a situation not
described here, STOP. Do NOT guess or infer intent. Ask the orchestrator a specific
question: "The spec says X but I encountered Y -- should I do A or B?" Wait for the
answer before writing code for that part.
