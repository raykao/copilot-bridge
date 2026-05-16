# Phase 2: copilot-bridge ACP Channel Adapter

**Spec source:** workbench/acp-migration-plan.md sections 3, 9 (Phase 2), 11
**Branch:** feat/acp-channel-adapter (at origin/main HEAD, no new commits yet)
**Repo:** raykao/copilot-bridge
**Workbench path:** workspaces/bob/workbench/copilot-bridge
**Beads task:** copilot-nnw

---

## Problem and Approach

Kanban Phase 1 built an `AcpAdapter` that connects to a raw `copilot --acp --port N`
process. Phase 2 replaces that raw process with copilot-bridge as the ACP server.

The bridge exposes a WebSocket endpoint per bot (`WS /<botName>`) on a dedicated port
(default 3030, configurable via `platforms.acp.port`). Kanban connects, does an ACP
`initialize` handshake, then sends `session/new` + `session/prompt` requests and receives
`session/update` notifications in real time. The bridge maps these to `CopilotBridge`
internals (bridge.ts) with no HTTP callbacks, no second connection, no callback tokens.

**Transport choice:** `ws.WebSocketServer` (already in package.json as `ws: ^8.20.0`)
with a plain `node:http` server. No Fastify - ACP needs WebSocket only, not REST routes.
`@fastify/websocket` is NOT installed and must NOT be added.

**No new npm dependencies.** Everything needed (`ws`, `@types/ws`, `node:http`) is
already present.

---

## Wire protocol (ACP over WebSocket)

All messages are UTF-8 JSON-encoded JSON-RPC 2.0 objects.

### Client -> Server requests (have `method` AND `id`)

```
initialize          { jsonrpc, method: "initialize", id, params: { protocolVersion: string, clientCapabilities: {} } }
session/new         { jsonrpc, method: "session/new", id, params: { model?: string } }
session/prompt      { jsonrpc, method: "session/prompt", id, params: { sessionId: string, prompt: string } }
session/cancel      { jsonrpc, method: "session/cancel", id, params: { sessionId: string } }
session/close       { jsonrpc, method: "session/close", id, params: { sessionId: string } }
```

### Server -> Client responses (have `id`, have `result` or `error`, no `method`)

```
initialize result   { jsonrpc, id, result: { protocolVersion: string, agentCapabilities: {}, authMethods: [] } }
session/new result  { jsonrpc, id, result: { sessionId: string } }
session/prompt result { jsonrpc, id, result: { stopReason: "idle" | "error" | "cancelled" } }
session/cancel result { jsonrpc, id, result: {} }
session/close result  { jsonrpc, id, result: {} }
error response      { jsonrpc, id, error: { code: number, message: string } }
```

### Server -> Client requests (have `method` AND `id`, client must respond)

```
session/request_permission  { jsonrpc, method: "session/request_permission", id: <uuid>,
                               params: { sessionId: string, kind: string, toolCallId?: string } }
```

### Client -> Server responses to server-initiated requests (have `id`, have `result`, no `method`)

```
permission response  { jsonrpc, id: <same uuid>, result: { decision: "allow" | "deny" } }
```

### Server -> Client notifications (have `method`, NO `id`)

```
session/update  { jsonrpc, method: "session/update", params: { sessionId: string, event: SessionEvent } }
```

### JSON-RPC error codes used

```
-32700  Parse error (malformed JSON)
-32600  Invalid request (missing jsonrpc or method on a request)
-32601  Method not found
-32603  Internal error
```

---

## Files to create

| Path | Purpose |
|------|---------|
| `src/channels/acp/types.ts` | Config types (AcpBotConfig, AcpPlatformConfig) + JSON-RPC message types |
| `src/channels/acp/connection-handler.ts` | Per-WS-connection state: session map, permission map, message dispatch |
| `src/channels/acp/server.ts` | node:http server + ws.WebSocketServer, routes connections to handler |
| `src/channels/acp/startup.ts` | Exports `startAcpServer(config, bridge)` called from index.ts |
| `src/channels/acp/index.ts` | Re-exports `startAcpServer` |
| `src/channels/acp/connection-handler.test.ts` | Unit tests (mocked bridge) |
| `src/channels/acp/server.test.ts` | Integration test: real WS client, mocked bridge |

## Files to modify

| Path | Change |
|------|--------|
| `src/types.ts` | Add `AcpBotConfig`, `AcpPlatformConfig`; add `acp?: AcpPlatformConfig` to `AppConfig` |
| `src/config.ts` | Add `getAcpPlatformConfig()` function |
| `src/index.ts` | Boot ACP server if `platforms.acp` is configured |

---

## Task Specs

---

### t0: Types

**Goal:** Define all TypeScript types used across the ACP channel adapter.

**Files to read (before writing anything):**
- `src/types.ts` lines 1-130 (BotConfig, AccessConfig, AppConfig, HttpPlatformConfig for reference)

**Files to modify:**
- `src/types.ts`

**Files to create:**
- `src/channels/acp/types.ts`

---

#### Change 1: src/types.ts

After the closing brace of `HttpPlatformConfig` (currently around line 50), insert:

```typescript
// ACP platform: per-bot config (lives under platforms.acp.bots in config.json)
export interface AcpBotConfig {
  agent?: string;            // agent persona name (maps to AGENTS.md filename)
  model?: string;            // default model id for sessions under this bot
  workingDirectory?: string; // absolute path to bot workspace; REQUIRED at runtime
  admin?: boolean;           // bot can manage other agents
  access?: AccessConfig;     // user-level access control (unused in Phase 2, reserved)
  token?: string;            // optional bearer token for remote deployments
}

// ACP platform config (lives under platforms.acp in config.json)
export interface AcpPlatformConfig {
  port?: number;   // WebSocket port; default 3030
  bind?: string;   // bind address; default "127.0.0.1"
  bots: Record<string, AcpBotConfig>;
}
```

Then find `export interface AppConfig {` (currently around line 117). The `platforms` field
is currently typed `platforms: Record<string, PlatformConfig>`. Change it to:

```typescript
export interface AppConfig {
  platforms: Record<string, PlatformConfig> & {
    acp?: AcpPlatformConfig;
  };
  // ... rest unchanged
}
```

Wait -- do NOT use an intersection type here because it causes TypeScript issues with
index signatures. Instead, add a separate field next to `platforms`:

Actually, `AppConfig` currently has `platforms: Record<string, PlatformConfig>`. Do NOT
change the `platforms` type. Instead, add a new field right below it:

```typescript
  acpPlatform?: AcpPlatformConfig; // parsed from platforms.acp at startup
```

No -- that's also wrong, it would require changes in config.ts loading.

**Correct approach:** Leave `AppConfig.platforms` unchanged as
`Record<string, PlatformConfig>`. The ACP config is accessed at runtime by casting:
`config.platforms['acp'] as AcpPlatformConfig | undefined`. This is exactly how the HTTP
platform is accessed in `src/index.ts` line 571:
`config.platforms.http as HttpPlatformConfig | undefined`. No change to `AppConfig` needed.

So the ONLY change to `src/types.ts` is: insert `AcpBotConfig` and `AcpPlatformConfig`
after `HttpPlatformConfig`. Add them also to the export list if types.ts has an explicit
export list (check the file - if it uses `export interface` inline, no separate export
list is needed).

---

#### Change 2: src/channels/acp/types.ts (create new)

Create this file with the exact content below. Do not add or remove fields:

```typescript
import type { SessionEvent } from '@github/copilot-sdk';

// JSON-RPC 2.0 base types

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  id: string | number;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  // no id field
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// Union for anything arriving from the client
export type AcpIncoming = JsonRpcRequest | JsonRpcResponse;

// --- Per-method param and result types ---

export interface InitializeParams {
  protocolVersion: string;
  clientCapabilities: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: string;
  agentCapabilities: Record<string, unknown>;
  authMethods: unknown[];
}

export interface SessionNewParams {
  model?: string; // optional model override; workingDirectory and agent come from server config
}

export interface SessionNewResult {
  sessionId: string;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: string;
}

export interface SessionPromptResult {
  stopReason: 'idle' | 'error' | 'cancelled';
}

export interface SessionCancelParams {
  sessionId: string;
}

export interface SessionCloseParams {
  sessionId: string;
}

export interface SessionRequestPermissionParams {
  sessionId: string;
  kind: string;
  toolCallId?: string;
}

export interface SessionRequestPermissionResult {
  decision: 'allow' | 'deny';
}

// Outbound notifications from server to client

export interface SessionUpdateNotification extends JsonRpcNotification {
  method: 'session/update';
  params: {
    sessionId: string;
    event: SessionEvent;
  };
}
```

**Done criteria for t0:**
- `npx tsc --noEmit` exits 0 in `workspaces/bob/workbench/copilot-bridge`
- No new test files needed for this task

> ESCALATION RULE: If any requirement in this spec is ambiguous, contradictory, or
> covers a situation not described here, STOP. Do NOT guess or infer intent. Ask
> the orchestrator a specific question: "The spec says X but I encountered Y -- should
> I do A or B?" Wait for the answer before writing code for that part.

---

### t1: Config

**Goal:** Add `getAcpPlatformConfig()` to config.ts so the rest of the codebase can
retrieve the ACP platform config without casting.

**Files to read (before writing anything):**
- `src/config.ts` lines 440-480 (the `_resolveHttpApiKeys` and `getHttpApiKeySecret`
  functions - use them as the exact pattern to follow)
- `src/types.ts` (the AcpPlatformConfig and AcpBotConfig you just added in t0)

**Files to modify:**
- `src/config.ts`
- `src/config.test.ts`

---

#### Change 1: src/config.ts

Find the import at line 4:
```typescript
import type { AppConfig, ChannelConfig, BotConfig, InterAgentConfig, AccessConfig, BridgeProviderConfig, HttpPlatformConfig } from './types.js';
```

Change it to add `AcpPlatformConfig`:
```typescript
import type { AppConfig, ChannelConfig, BotConfig, InterAgentConfig, AccessConfig, BridgeProviderConfig, HttpPlatformConfig, AcpPlatformConfig } from './types.js';
```

Then, after the `getHttpApiKeyNames()` function (which is after `getHttpApiKeySecret`),
add the following function. Insert it as a new block - do not modify any existing code:

```typescript
/**
 * Get the ACP platform config, with defaults applied.
 * Returns undefined if platforms.acp is not configured.
 */
export function getAcpPlatformConfig(): AcpPlatformConfig | undefined {
  const raw = getConfig().platforms['acp'] as AcpPlatformConfig | undefined;
  if (!raw) return undefined;
  return {
    port: raw.port ?? 3030,
    bind: raw.bind ?? '127.0.0.1',
    bots: raw.bots ?? {},
  };
}
```

---

#### Change 2: src/config.test.ts

Open the file and find an existing test that exercises `platforms` config parsing
(search for `platforms` in the file). Add the following test block in the same
`describe` group as the other platform tests (or at the end of the top-level describe
if no platform group exists):

```typescript
describe('getAcpPlatformConfig', () => {
  it('returns undefined when platforms.acp is absent', () => {
    loadConfig({ platforms: { mattermost: { url: 'http://localhost', botToken: 'x' } } } as any);
    expect(getAcpPlatformConfig()).toBeUndefined();
  });

  it('returns config with defaults when platforms.acp is present', () => {
    loadConfig({
      platforms: {
        acp: {
          bots: {
            bob: { agent: 'bob', model: 'claude-sonnet-4.6', workingDirectory: '/workspaces/bob' },
          },
        },
      },
    } as any);
    const cfg = getAcpPlatformConfig();
    expect(cfg).toBeDefined();
    expect(cfg!.port).toBe(3030);
    expect(cfg!.bind).toBe('127.0.0.1');
    expect(cfg!.bots['bob'].agent).toBe('bob');
  });

  it('respects explicit port and bind', () => {
    loadConfig({
      platforms: {
        acp: { port: 4040, bind: '0.0.0.0', bots: {} },
      },
    } as any);
    const cfg = getAcpPlatformConfig();
    expect(cfg!.port).toBe(4040);
    expect(cfg!.bind).toBe('0.0.0.0');
  });
});
```

Also add `getAcpPlatformConfig` to the import from `'./config.js'` at the top of the
test file (wherever `getHttpApiKeySecret` or similar functions are imported from).

**Done criteria for t1:**
- `npx tsc --noEmit` exits 0
- `npm test -- --testPathPattern=config.test` passes (all tests including the 3 new ones)

> ESCALATION RULE: If any requirement in this spec is ambiguous, contradictory, or
> covers a situation not described here, STOP. Do NOT guess or infer intent. Ask
> the orchestrator a specific question: "The spec says X but I encountered Y -- should
> I do A or B?" Wait for the answer before writing code for that part.

---

### t2: Connection handler

**Goal:** Implement `AcpConnectionHandler` -- the per-WebSocket-connection class that
owns the session map, permission promise map, and JSON-RPC message dispatch.

**Files to read (before writing anything):**
- `src/core/bridge.ts` full file (CopilotBridge API: createSession, abortSession, getSession)
- `src/channels/acp/types.ts` (all types from t0)
- `src/types.ts` (AcpBotConfig)
- `src/channels/http/acp-permission-handler.ts` (permission parking pattern -- read but
  do NOT copy wholesale; the AcpConnectionHandler permission flow is simpler)
- `node_modules/@github/copilot-sdk/dist/types.d.ts` lines containing
  `PermissionHandler`, `PermissionRequest`, `PermissionRequestResult` (for exact types)
- `node_modules/@github/copilot-sdk/dist/session.d.ts` (CopilotSession API: send, on,
  abort, disconnect, sessionId)

**Files to create:**
- `src/channels/acp/connection-handler.ts`
- `src/channels/acp/connection-handler.test.ts`

---

#### connection-handler.ts: exact interface and class

```typescript
import { randomUUID } from 'node:crypto';
import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import type {
  AcpIncoming,
  JsonRpcRequest,
  JsonRpcResponse,
  InitializeParams,
  InitializeResult,
  SessionNewParams,
  SessionNewResult,
  SessionPromptParams,
  SessionPromptResult,
  SessionCancelParams,
  SessionCloseParams,
  SessionRequestPermissionParams,
  SessionRequestPermissionResult,
  SessionUpdateNotification,
} from './types.js';
import type { CopilotSession, PermissionRequestResult, SessionEvent } from '@github/copilot-sdk';
import { createLogger } from '../../logger.js';

const log = createLogger('acp-connection');

// Tracks one active copilot-sdk session for this WebSocket connection
interface SessionEntry {
  session: CopilotSession;
  unsubscribe: () => void; // call to remove the event listener registered at session/new
}

// Tracks an in-flight server->client permission request
interface PendingPermission {
  resolve: (result: PermissionRequestResult) => void;
  reject: (err: Error) => void;
}
```

The class:

```typescript
export class AcpConnectionHandler {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private initialized = false;

  constructor(
    private readonly botCfg: AcpBotConfig,
    private readonly bridge: CopilotBridge,
    private readonly send: (msg: object) => void,  // caller must JSON.stringify and send
  ) {}

  async handle(raw: string): Promise<void> { ... }  // main entry: parse + dispatch

  async closeAll(): Promise<void> { ... }  // called on WS close: abort+disconnect all sessions
}
```

---

#### connection-handler.ts: handle() implementation

`handle(raw: string)` must do the following IN ORDER:

1. Parse `raw` as JSON. If it throws, send parse error and return:
   ```typescript
   this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
   return;
   ```

2. Determine message type:
   - If parsed object has a `method` field (string): it is a client request or notification.
     Dispatch to `handleRequest(parsed as AcpIncoming)`.
   - If parsed object has `result` or `error` field but NO `method` field: it is a
     response to a server-originated request (permission response). Dispatch to
     `handlePermissionResponse(parsed as JsonRpcResponse)`.
   - Otherwise: send error -32600 "Invalid request" and return.

3. `handleRequest(msg)`:
   ```
   switch (msg.method):
     "initialize"       -> handleInitialize(msg)
     "session/new"      -> handleSessionNew(msg)
     "session/prompt"   -> handleSessionPrompt(msg)
     "session/cancel"   -> handleSessionCancel(msg)
     "session/close"    -> handleSessionClose(msg)
     default            -> send error -32601 "Method not found" with msg.id
   ```

4. `handlePermissionResponse(msg: JsonRpcResponse)`:
   - Look up `this.pendingPermissions.get(String(msg.id))`
   - If not found: log a warning and return (silently drop)
   - If found: remove from map, then:
     - If msg.result: call `pending.resolve(toPermissionResult(msg.result as SessionRequestPermissionResult))`
     - If msg.error: call `pending.reject(new Error(msg.error.message))`

5. `toPermissionResult(r: SessionRequestPermissionResult): PermissionRequestResult`:
   - If `r.decision === 'allow'`: return `{ kind: 'approved' } as unknown as PermissionRequestResult`
   - Otherwise: return `{ kind: 'denied-by-rules', rules: [] } as unknown as PermissionRequestResult`
   - Use the exact same casts as in `src/channels/http/acp-permission-handler.ts` lines
     8-9 (the APPROVED and DENIED constants).

---

#### connection-handler.ts: handleInitialize()

```typescript
private sendResponse(id: string | number, result: unknown): void {
  this.send({ jsonrpc: '2.0', id, result });
}

private sendError(id: string | number | null, code: number, message: string): void {
  this.send({ jsonrpc: '2.0', id, error: { code, message } });
}

private handleInitialize(msg: JsonRpcRequest): void {
  const params = msg.params as InitializeParams;
  this.initialized = true;
  const result: InitializeResult = {
    protocolVersion: params.protocolVersion,  // echo back what the client sent
    agentCapabilities: {},
    authMethods: [],
  };
  this.sendResponse(msg.id, result);
}
```

---

#### connection-handler.ts: handleSessionNew()

```typescript
private async handleSessionNew(msg: JsonRpcRequest): Promise<void> {
  const params = (msg.params ?? {}) as SessionNewParams;
  const workingDirectory = this.botCfg.workingDirectory ?? process.cwd();
  const model = params.model ?? this.botCfg.model;
  const agentName = this.botCfg.agent;

  let session: CopilotSession;
  try {
    session = await this.bridge.createSession({
      workingDirectory,
      model,
      agent: agentName,
      onPermissionRequest: this.makePermissionHandler(),
    });
  } catch (err) {
    this.sendError(msg.id, -32603, `Failed to create session: ${(err as Error).message}`);
    return;
  }

  // Register a persistent event listener that forwards all SDK events as session/update
  const unsubscribe = session.on((event: SessionEvent) => {
    const notification: SessionUpdateNotification = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: session.sessionId, event },
    };
    this.send(notification);
  });

  this.sessions.set(session.sessionId, { session, unsubscribe });

  const result: SessionNewResult = { sessionId: session.sessionId };
  this.sendResponse(msg.id, result);
}
```

---

#### connection-handler.ts: makePermissionHandler()

```typescript
private makePermissionHandler() {
  return async (request: import('@github/copilot-sdk').PermissionRequest, invocation: { sessionId: string }): Promise<PermissionRequestResult> => {
    const requestId = randomUUID();
    const permissionRequest: import('./types.js').JsonRpcRequest = {
      jsonrpc: '2.0',
      method: 'session/request_permission',
      id: requestId,
      params: {
        sessionId: invocation.sessionId,
        kind: request.kind,
        toolCallId: (request as any).toolCallId,
      } satisfies SessionRequestPermissionParams,
    };
    this.send(permissionRequest);

    return new Promise<PermissionRequestResult>((resolve, reject) => {
      this.pendingPermissions.set(requestId, { resolve, reject });
    });
  };
}
```

---

#### connection-handler.ts: handleSessionPrompt()

`session/prompt` is a request: client waits for the response. The response is sent AFTER
the session becomes idle. Events stream via `session/update` notifications in parallel.

```typescript
private async handleSessionPrompt(msg: JsonRpcRequest): Promise<void> {
  const { sessionId, prompt } = msg.params as SessionPromptParams;
  const entry = this.sessions.get(sessionId);
  if (!entry) {
    this.sendError(msg.id, -32603, `Session not found: ${sessionId}`);
    return;
  }

  let stopReason: SessionPromptResult['stopReason'] = 'idle';

  // Temporary per-turn listener to detect turn completion
  const idlePromise = new Promise<void>((resolve) => {
    const unsub = entry.session.on((event: SessionEvent) => {
      if (event.type === 'session.idle') {
        unsub();
        resolve();
      } else if (event.type === 'session.error') {
        stopReason = 'error';
        unsub();
        resolve();
      }
    });
  });

  try {
    await entry.session.send({ prompt });
  } catch (err) {
    this.sendError(msg.id, -32603, `send failed: ${(err as Error).message}`);
    return;
  }

  await idlePromise;

  const result: SessionPromptResult = { stopReason };
  this.sendResponse(msg.id, result);
}
```

---

#### connection-handler.ts: handleSessionCancel(), handleSessionClose(), closeAll()

```typescript
private async handleSessionCancel(msg: JsonRpcRequest): Promise<void> {
  const { sessionId } = msg.params as SessionCancelParams;
  const entry = this.sessions.get(sessionId);
  if (!entry) {
    this.sendError(msg.id, -32603, `Session not found: ${sessionId}`);
    return;
  }
  try {
    await entry.session.abort();
  } catch { /* best-effort */ }
  this.sendResponse(msg.id, {});
}

private async handleSessionClose(msg: JsonRpcRequest): Promise<void> {
  const { sessionId } = msg.params as SessionCloseParams;
  const entry = this.sessions.get(sessionId);
  if (!entry) {
    this.sendError(msg.id, -32603, `Session not found: ${sessionId}`);
    return;
  }
  entry.unsubscribe();
  this.sessions.delete(sessionId);
  try {
    await entry.session.disconnect();
  } catch { /* best-effort */ }
  this.sendResponse(msg.id, {});
}

async closeAll(): Promise<void> {
  for (const [sessionId, entry] of this.sessions) {
    entry.unsubscribe();
    try { await entry.session.abort(); } catch { /* best-effort */ }
    try { await entry.session.disconnect(); } catch { /* best-effort */ }
  }
  this.sessions.clear();
  // Reject all pending permission requests
  for (const [, pending] of this.pendingPermissions) {
    pending.reject(new Error('Connection closed'));
  }
  this.pendingPermissions.clear();
}
```

---

#### connection-handler.test.ts: exact test cases

Use Jest (the existing test framework in the repo). Mock `CopilotBridge` and
`CopilotSession` manually (do NOT use jest.mock() for sdk modules -- create minimal
stub objects). Pattern: build a fake `bridge` object with `createSession` that returns a
fake `session`. Check existing test files (e.g., `src/channels/http/auth.test.ts`) for
the import style and Jest config.

**Test 1: parse error on malformed JSON**
- Input: `handle('not json')`
- Expected: `send` called once with object matching `{ jsonrpc: '2.0', id: null, error: { code: -32700 } }`

**Test 2: method not found**
- Input: `handle(JSON.stringify({ jsonrpc: '2.0', method: 'nonexistent', id: 1, params: {} }))`
- Expected: `send` called with `{ jsonrpc: '2.0', id: 1, error: { code: -32601 } }`

**Test 3: initialize echoes protocolVersion**
- Input: `handle(JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '0.3', clientCapabilities: {} } }))`
- Expected: `send` called with `{ jsonrpc: '2.0', id: 1, result: { protocolVersion: '0.3', agentCapabilities: {}, authMethods: [] } }`

**Test 4: session/new creates session and returns sessionId**
- Setup: fake `bridge.createSession` resolves to a fake session with `sessionId: 'test-sid'`
  and `on: () => () => {}` (no-op unsubscribe) and `send: async () => 'msg-id'`
- Input: `handle(JSON.stringify({ jsonrpc: '2.0', method: 'session/new', id: 2, params: {} }))`
- Expected: `send` called with `{ jsonrpc: '2.0', id: 2, result: { sessionId: 'test-sid' } }`
- Expected: `bridge.createSession` was called with `workingDirectory: '/test/workspace'`
  (pass `workingDirectory: '/test/workspace'` in the AcpBotConfig to the constructor)

**Test 5: session/prompt waits for idle and returns stopReason**
- Setup: session from test 4 is already created. The fake `session.on` handler stubs:
  - First call (from session/new): returns no-op unsubscribe
  - Second call (from session/prompt idle detection): immediately fires a `session.idle`
    event synchronously before returning the unsubscribe fn. Implement as:
    ```typescript
    let callCount = 0;
    fakeSession.on = (handler: any) => {
      callCount++;
      if (callCount === 2) { handler({ type: 'session.idle' }); }
      return () => {};
    };
    ```
- Run session/new first, then send session/prompt request
- Expected: final `send` call includes `{ result: { stopReason: 'idle' } }`

**Test 6: permission request parks and resolves when response arrives**
- Setup: fake `bridge.createSession` calls `onPermissionRequest({ kind: 'shell' }, { sessionId: 's1' })`
  synchronously from within `createSession` before resolving. Capture the returned Promise.
- After session/new: call `handle` with a permission response matching the requestId
  sent by the server
- The captured Promise must resolve (not hang)
- Verify `send` was called with a message where `method === 'session/request_permission'`
  and `params.kind === 'shell'`

**Test 7: closeAll disconnects all sessions**
- Create a session, then call `closeAll()`
- Verify `fakeSession.abort` and `fakeSession.disconnect` were both called

**Done criteria for t2:**
- `npx tsc --noEmit` exits 0
- `npm test -- --testPathPattern=connection-handler.test` passes (all 7 tests)

> ESCALATION RULE: If any requirement in this spec is ambiguous, contradictory, or
> covers a situation not described here, STOP. Do NOT guess or infer intent. Ask
> the orchestrator a specific question: "The spec says X but I encountered Y -- should
> I do A or B?" Wait for the answer before writing code for that part.

---

### t3: Server and startup

**Goal:** Implement the `node:http` + `ws.WebSocketServer` ACP server and the
`startAcpServer` export used by index.ts.

**Files to read (before writing anything):**
- `src/channels/acp/connection-handler.ts` (from t2)
- `src/channels/acp/types.ts` (from t0)
- `src/types.ts` (AcpBotConfig, AcpPlatformConfig from t0)
- `src/core/bridge.ts` (CopilotBridge type)
- `src/channels/http/server.ts` full file (Fastify server pattern -- for reference only;
  ACP server does NOT use Fastify)
- `node_modules/@types/ws/index.d.ts` lines 1-80 (WebSocket and WebSocketServer API)
- `src/logger.ts` (for createLogger import path and usage)

**Files to create:**
- `src/channels/acp/server.ts`
- `src/channels/acp/startup.ts`
- `src/channels/acp/index.ts`
- `src/channels/acp/server.test.ts`

---

#### server.ts: exact content

```typescript
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { AcpConnectionHandler } from './connection-handler.js';
import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import { createLogger } from '../../logger.js';

const log = createLogger('acp-server');

export interface AcpServerOptions {
  bind: string;
  port: number;
  bots: Record<string, AcpBotConfig>;
}

export interface AcpServer {
  close(): Promise<void>;
}

export async function createAcpServer(
  opts: AcpServerOptions,
  bridge: CopilotBridge,
): Promise<AcpServer> {
  const httpServer: HttpServer = createServer((req, res) => {
    // Only WebSocket upgrades are handled; reject plain HTTP
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('ACP WebSocket server - use ws:// protocol');
  });

  const wss = new WebSocketServer({ noServer: true });

  // Route upgrade requests by URL path to the correct bot config
  httpServer.on('upgrade', (request: IncomingMessage, socket, head) => {
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname;
    // pathname is expected to be "/<botName>"
    const botName = pathname.slice(1); // strip leading "/"
    const botCfg = opts.bots[botName];

    if (!botCfg) {
      log.warn(`ACP: unknown bot "${botName}", rejecting upgrade`);
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Optional bearer token check
    if (botCfg.token) {
      const authHeader = request.headers['authorization'] ?? '';
      const expected = `Bearer ${botCfg.token}`;
      if (authHeader !== expected) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request, botCfg);
    });
  });

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, botCfg: AcpBotConfig) => {
    const handler = new AcpConnectionHandler(botCfg, bridge, (msg) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    });

    ws.on('message', (data) => {
      handler.handle(data.toString()).catch((err) => {
        log.error('ACP handler error', { err });
      });
    });

    ws.on('close', () => {
      handler.closeAll().catch((err) => {
        log.error('ACP closeAll error', { err });
      });
    });

    ws.on('error', (err) => {
      log.error('ACP WebSocket error', { err });
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(opts.port, opts.bind, () => resolve());
    httpServer.once('error', reject);
  });

  log.info(`ACP server listening on ws://${opts.bind}:${opts.port}`);

  return {
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        wss.close();
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
```

---

#### startup.ts: exact content

```typescript
import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpPlatformConfig } from '../../types.js';
import { createAcpServer, type AcpServer } from './server.js';

export { type AcpServer };

export async function startAcpServer(
  acpConfig: AcpPlatformConfig,
  bridge: CopilotBridge,
): Promise<AcpServer> {
  const bind = acpConfig.bind ?? '127.0.0.1';
  const port = acpConfig.port ?? 3030;
  return createAcpServer({ bind, port, bots: acpConfig.bots }, bridge);
}
```

---

#### index.ts: exact content

```typescript
export { startAcpServer, type AcpServer } from './startup.js';
```

---

#### server.test.ts: exact test cases

Use Jest. Import `WebSocket` from `'ws'` for the test client. Use a real `node:http` +
`ws.WebSocketServer` instance on a random port (pass `port: 0` to get an OS-assigned
port; after `listen` call `httpServer.address()` to get the actual port). Mock
`CopilotBridge` as a minimal object with `createSession` that returns a fake session.

**Setup (beforeEach):**
```typescript
let server: AcpServer;
let port: number;
let fakeBridge: CopilotBridge;

beforeEach(async () => {
  const fakeSession = {
    sessionId: 'ws-test-sid',
    on: () => () => {},
    send: async () => 'msg-id',
    abort: async () => {},
    disconnect: async () => {},
  };
  fakeBridge = { createSession: async () => fakeSession } as unknown as CopilotBridge;

  // Use port 0 to let OS pick; createAcpServer must expose the actual port
  // NOTE: createAcpServer as specified uses a fixed port.
  // For testing, call createAcpServer with port: 0 and extract actual port.
  // Modify createAcpServer to return the actual bound port in the AcpServer object:
  //   interface AcpServer { close(): Promise<void>; port: number; }
  // Update server.ts to set server.port = (httpServer.address() as AddressInfo).port
  server = await createAcpServer({ bind: '127.0.0.1', port: 0, bots: {
    bob: { agent: 'bob', model: 'claude-sonnet-4.6', workingDirectory: '/tmp/test' },
  }}, fakeBridge);
  port = server.port;
});

afterEach(async () => {
  await server.close();
});
```

**IMPORTANT:** The `AcpServer` interface must expose `port: number`. Update `server.ts`
and `startup.ts` accordingly:
- In `server.ts`: change `AcpServer` to `{ close(): Promise<void>; port: number }`,
  set `port` to `(httpServer.address() as import('node:net').AddressInfo).port` after
  the listen callback fires.

**Test 1: unknown bot path returns 404 upgrade rejection**
- Connect `new WebSocket('ws://127.0.0.1:${port}/unknown')`
- Listen for `'error'` event
- Expected: WebSocket emits an error (connection rejected with 404)

**Test 2: initialize handshake over real WebSocket**
- Connect `new WebSocket('ws://127.0.0.1:${port}/bob')`
- After `open`, send:
  ```json
  {"jsonrpc":"2.0","method":"initialize","id":1,"params":{"protocolVersion":"0.3","clientCapabilities":{}}}
  ```
- Collect first `message` event
- Expected: parsed result has `{ id: 1, result: { protocolVersion: "0.3", agentCapabilities: {}, authMethods: [] } }`

**Test 3: session/new returns sessionId over real WebSocket**
- Connect to `/bob`, complete initialize (send initialize, wait for response)
- Send:
  ```json
  {"jsonrpc":"2.0","method":"session/new","id":2,"params":{}}
  ```
- Collect next message
- Expected: `{ id: 2, result: { sessionId: "ws-test-sid" } }`

**Test 4: bearer token rejection**
- Add `token: 'secret'` to the `bob` bot config in the server options
- Connect `new WebSocket('ws://127.0.0.1:${port}/bob')` WITHOUT Authorization header
- Expected: WebSocket emits error (401 upgrade rejection)

**Done criteria for t3:**
- `npx tsc --noEmit` exits 0
- `npm test -- --testPathPattern=server.test` passes (all 4 tests)
- `npm test -- --testPathPattern=connection-handler.test` still passes (regression check)

> ESCALATION RULE: If any requirement in this spec is ambiguous, contradictory, or
> covers a situation not described here, STOP. Do NOT guess or infer intent. Ask
> the orchestrator a specific question: "The spec says X but I encountered Y -- should
> I do A or B?" Wait for the answer before writing code for that part.

---

### t4: index.ts wiring

**Goal:** Boot the ACP server from `src/index.ts` at startup, following the exact same
pattern used for the HTTP platform.

**Files to read (before writing anything):**
- `src/index.ts` lines 570-640 (the HTTP platform startup block -- copy its structure
  exactly, adapting for ACP)
- `src/config.ts` (the `getAcpPlatformConfig` function added in t1)
- `src/channels/acp/index.ts` (the export from t3)

**Files to modify:**
- `src/index.ts`

---

#### Exact change to src/index.ts

Find this line (currently around line 638, just after the HTTP startup block ends):
```typescript
  // Resolve non-UID Slack access entries at startup
```

Insert the following block immediately BEFORE that line:

```typescript
  // Boot ACP WebSocket server if platforms.acp is configured
  const { getAcpPlatformConfig } = await import('./config.js');
  const acpConfig = getAcpPlatformConfig();
  if (acpConfig) {
    const { startAcpServer } = await import('./channels/acp/index.js');
    const acpServer = await startAcpServer(acpConfig, bridge);
    log.info(`ACP server listening on ws://${acpConfig.bind ?? '127.0.0.1'}:${acpConfig.port ?? 3030}`);
    process.on('SIGTERM', () => {
      acpServer.close().catch((err) => log.error('ACP server close error', { err }));
    });
  }
```

**Note on the import:** `getAcpPlatformConfig` is already exported from `./config.js`.
At the top of `src/index.ts` (line 1), `loadConfig` and others are imported from
`'./config.js'`. ADD `getAcpPlatformConfig` to that existing import rather than using a
dynamic `import('./config.js')` inside the block. Change line 1 of index.ts from:

```typescript
import { loadConfig, getConfig, getHttpApiKeySecret, isConfiguredChannel, ... } from './config.js';
```

to include `getAcpPlatformConfig`:

```typescript
import { loadConfig, getConfig, getHttpApiKeySecret, isConfiguredChannel, ..., getAcpPlatformConfig } from './config.js';
```

Then the ACP block simplifies to:

```typescript
  // Boot ACP WebSocket server if platforms.acp is configured
  const acpConfig = getAcpPlatformConfig();
  if (acpConfig) {
    const { startAcpServer } = await import('./channels/acp/index.js');
    const acpServer = await startAcpServer(acpConfig, bridge);
    log.info(`ACP server ready on ws://${acpConfig.bind ?? '127.0.0.1'}:${acpConfig.port ?? 3030}`);
    process.on('SIGTERM', () => {
      acpServer.close().catch((err) => log.error('ACP server close error', { err }));
    });
  }
```

No new test file needed for this task. The existing test `src/index.registerHttpChannel.test.ts`
must still pass as a regression check.

**Done criteria for t4:**
- `npx tsc --noEmit` exits 0
- `npm test` passes (all existing tests pass; no regressions)
- Manually verify: add `"acp": { "bots": { "bob": { "workingDirectory": "/tmp" } } }` to
  `platforms` in a test config.json, run `node dist/index.js`, confirm log line
  `ACP server ready on ws://127.0.0.1:3030` appears at startup.

> ESCALATION RULE: If any requirement in this spec is ambiguous, contradictory, or
> covers a situation not described here, STOP. Do NOT guess or infer intent. Ask
> the orchestrator a specific question: "The spec says X but I encountered Y -- should
> I do A or B?" Wait for the answer before writing code for that part.

---

## Orchestration loop config

**Tasks:** t0 -> t1 -> t2 -> t3 -> t4 (linear, each builds on prior)
**Branch:** `feat/acp-channel-adapter` in `workspaces/bob/workbench/copilot-bridge`
**Impl worktree:** `workspaces/bob/workbench/impl/acp-bridge` (reset from feat/acp-channel-adapter before each task)
**Implementer model:** gpt-5.5
**Reviewer model:** claude-sonnet-4.6

## Phase 2 done criteria (all must be true before PR)

- [ ] `npx tsc --noEmit` exits 0
- [ ] `npm test` passes (all tests, including 10+ new ones across 3 new test files)
- [ ] `platforms.acp` config section boots the bridge and opens port 3030
- [ ] A real WS client (`wscat` or test script) can connect to `ws://127.0.0.1:3030/bob`,
      send `initialize`, and receive a valid response
- [ ] PR opened against `raykao/copilot-bridge` with description linking to this plan
- [ ] `copilot-nnw` Beads task updated and eventually closed
- [ ] Dashboard (dark-factory#5) updated
