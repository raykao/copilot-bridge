# ACP Session Methods: Spec Extensions (a9k.1)

Status: Spec (pre-implementation)
Date: 2026-05-20
Author: Bob (bridge team)
Related: copilot-a9k epic, workspaces/bill/research/bridge-authoritative-session-state.md

---

## Overview

This document specifies four new ACP JSON-RPC methods that make the bridge the
authoritative source of truth for session state. Together they let any ACP client
(kanban, Zed, third-party tools) hydrate cheaply on load, fetch missed turns on
reconnect, and receive live state changes without reassembling state from raw events.

Methods added:

| Method | Direction | Purpose |
|---|---|---|
| `session/get` | request/response | Snapshot of one session's metadata (no transcript) |
| `session/list` | request/response | All sessions known to the bridge |
| `session/transcript` | request/response | Cursor-based gap fetch from session-store |
| `session/subscribe` | request + server-push | Live state changes for one session |

One additional method for symmetry:

| Method | Direction | Purpose |
|---|---|---|
| `session/unsubscribe` | request/response | Cancel a `session/subscribe` subscription |

---

## Wire format conventions

All messages follow JSON-RPC 2.0. Requests have an `id` field; server-sent
notifications do not. A client may receive notifications at any time after
`initialize`.

Error codes follow the JSON-RPC 2.0 standard plus these bridge-specific codes:

| Code | Name | Meaning |
|---|---|---|
| -32700 | Parse error | Message is not valid JSON |
| -32600 | Invalid Request | Missing required field |
| -32601 | Method not found | Unknown method |
| -32603 | Internal error | Bridge-side failure |
| -32001 | Session not found | Requested session does not exist in bridge or CLI |
| -32002 | Resume failed | Session ID known but could not be resumed |

---

## `session/get`

Returns metadata for one session. Does NOT return the transcript.
Intended for cheap hydration on page load or WS reconnect.

### Request

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "session/get",
  "params": {
    "sessionId": "aa102c52-..."
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `sessionId` | `string` | yes | CLI session ID |

### Response

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": "aa102c52-...",
    "agent": "bob",
    "status": "idle",
    "currentTurnIndex": 5,
    "pendingPermissions": [],
    "updatedAt": "2026-05-20T15:00:00.000Z"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | `string` | CLI session ID |
| `agent` | `string \| null` | Agent name from session config, null if using AGENTS.md |
| `status` | `SessionStatus` | Current session status (see below) |
| `currentTurnIndex` | `number` | Highest turn_index in session-store for this session, or -1 if no turns |
| `pendingPermissions` | `PendingPermission[]` | Outstanding permission requests (see below) |
| `updatedAt` | `string` | ISO 8601 UTC timestamp of last state change |

### SessionStatus

```
"idle" | "in_progress" | "error" | "unknown"
```

| Value | Meaning |
|---|---|
| `idle` | Session is active and waiting for a prompt |
| `in_progress` | Session is currently processing a prompt |
| `error` | Session emitted `session.error` on most recent turn |
| `unknown` | Session exists in CLI but is not loaded in bridge memory (e.g. after restart); bridge has not received a status event for it |

`unknown` is normal after a bridge restart for sessions that were not yet resumed.
The client can still fetch transcript for `unknown` sessions via `session/transcript`.

### PendingPermission

```typescript
interface PendingPermission {
  requestId: string;         // UUID assigned by bridge when forwarding to client
  kind: string;              // e.g. "bash", "file_write" - from SDK PermissionRequest.kind
  toolCallId?: string;       // present when kind is a tool call
  requestedAt: string;       // ISO 8601 UTC
}
```

**Dependency note:** `pendingPermissions[]` is non-empty only after a9k.6 lands
(bridge-level permission tracking). Before a9k.6, this field is always `[]`.
The field is defined here so clients can code against the final shape from day one.

### Error cases

| Condition | Error code | Message |
|---|---|---|
| `sessionId` missing from params | -32600 | "Missing required field: sessionId" |
| Session not in CLI or bridge | -32001 | "Session not found: {sessionId}" |

---

## `session/list`

Returns all sessions known to the bridge (from the CLI session list).
The client filters by the session IDs it has cards for.

### Request

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/list",
  "params": {}
}
```

Params object is required but may be empty. No filter fields in v1.

### Response

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessions": [
      {
        "id": "aa102c52-...",
        "agent": "bob",
        "status": "idle",
        "currentTurnIndex": 5,
        "pendingPermissions": [],
        "updatedAt": "2026-05-20T15:00:00.000Z"
      }
    ]
  }
}
```

`sessions` is an array of `SessionState` objects (same shape as `session/get` result).

Sessions are returned in descending `updatedAt` order.

Sessions that exist in CLI but have never been loaded by the bridge will have
`status: "unknown"` and `currentTurnIndex` derived from session-store only.

### Error cases

No session-level errors; an empty array is a valid response.

---

## `session/transcript`

Cursor-based fetch of turns from the CLI session-store.
Used for disconnect recovery and initial hydration when `card_comments` is empty.

### Request

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/transcript",
  "params": {
    "sessionId": "aa102c52-...",
    "since": 3
  }
}
```

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `sessionId` | `string` | yes | - | CLI session ID |
| `since` | `number` | no | 0 | Return turns with `turn_index >= since`. Pass 0 to get all turns. |
| `limit` | `number` | no | 200 | Maximum number of turns to return. Hard cap: 500. |

### Response

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "sessionId": "aa102c52-...",
    "turns": [
      {
        "turnIndex": 3,
        "userMessage": "show me the logs",
        "assistantResponse": "Here are the logs...",
        "timestamp": "2026-05-20T01:20:00.000Z"
      }
    ],
    "hasMore": false
  }
}
```

| Field | Type | Description |
|---|---|---|
| `sessionId` | `string` | Echo of the requested session ID |
| `turns` | `Turn[]` | Ordered array of turns (ascending turn_index) |
| `hasMore` | `boolean` | True if more turns exist beyond this page (turn count exceeded `limit`) |

### Turn

```typescript
interface Turn {
  turnIndex: number;          // 0-based, from session-store turns.turn_index
  userMessage: string | null; // may be null for system-injected turns
  assistantResponse: string | null; // null if turn is incomplete (in_progress)
  timestamp: string;          // ISO 8601 UTC, from session-store turns.timestamp
}
```

### Error cases

| Condition | Error code | Message |
|---|---|---|
| `sessionId` missing | -32600 | "Missing required field: sessionId" |
| Session not in session-store | -32001 | "Session not found: {sessionId}" |
| `since` < 0 | -32600 | "since must be >= 0" |
| `limit` > 500 | -32600 | "limit must be <= 500" |

**Note:** A session that exists in CLI but has no turns in session-store returns
`{ turns: [], hasMore: false }` (not an error). This is the case for sessions
where `wireSessionStoreTracking` was never armed (see copilot-lhk; fixed in
bridge v0.15.0).

### Implementation note

The bridge reads session-store.db directly via `better-sqlite3`. This is a
read-only query and does not require an active CLI IPC connection.

```sql
SELECT turn_index, user_message, assistant_response, timestamp
FROM turns
WHERE session_id = ? AND turn_index >= ?
ORDER BY turn_index ASC
LIMIT ?
```

---

## `session/subscribe`

Client subscribes to live state changes for one session. Bridge sends a
`session/state_changed` notification whenever the session's status or
`pendingPermissions` list changes.

### Subscribe request

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/subscribe",
  "params": {
    "sessionId": "aa102c52-..."
  }
}
```

### Subscribe response

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "subscribed": true,
    "sessionId": "aa102c52-..."
  }
}
```

Bridge responds immediately with the ack. State pushes follow as notifications
(no `id` field, as they are server-initiated).

### `session/state_changed` notification

```json
{
  "jsonrpc": "2.0",
  "method": "session/state_changed",
  "params": {
    "id": "aa102c52-...",
    "agent": "bob",
    "status": "in_progress",
    "currentTurnIndex": 5,
    "pendingPermissions": [
      {
        "requestId": "f3a2...",
        "kind": "bash",
        "toolCallId": "call_abc123",
        "requestedAt": "2026-05-20T15:01:00.000Z"
      }
    ],
    "updatedAt": "2026-05-20T15:01:00.000Z"
  }
}
```

The `params` object is the full `SessionState` (same shape as `session/get` result).
The client replaces its local state on each push. No diff/patch; no reducer math.

### When bridge sends `session/state_changed`

Triggers (bridge fires a push on any of these):

1. Session status transitions: `session.in_progress` -> `session.idle` or `session.error` SDK events.
2. `pendingPermissions` list changes: a new permission request is added, or one is resolved.
3. `currentTurnIndex` increases: a new turn is written to session-store.

**Note:** trigger 3 only fires after a9k.4 lands (turn persistence via transcript endpoint).
Triggers 1 and 2 fire as soon as a9k.2 (subscribe implementation) ships.

### Subscription lifetime

- A subscription is scoped to the WS connection. Closing the WS cancels all subscriptions.
- A client may subscribe to multiple sessions on the same connection.
- Subscribing to the same sessionId twice on the same connection is a no-op; bridge
  responds with `{ subscribed: true }` and does not create a duplicate subscription.
- Subscriptions are NOT transferable to a new WS connection. On reconnect, the client
  must re-subscribe after calling `session/get` to re-hydrate.

### Error cases

| Condition | Error code | Message |
|---|---|---|
| `sessionId` missing | -32600 | "Missing required field: sessionId" |
| Session not found | -32001 | "Session not found: {sessionId}" |

---

## `session/unsubscribe`

Cancels a `session/subscribe` subscription.

### Request

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/unsubscribe",
  "params": {
    "sessionId": "aa102c52-..."
  }
}
```

### Response

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {}
}
```

If the session was not subscribed, bridge still responds with success (idempotent).

---

## Implementation order and dependencies

| Task | Methods | Depends on | Notes |
|---|---|---|---|
| a9k.2 | `session/get`, `session/list`, `session/subscribe`, `session/unsubscribe` | copilot-lhk (fixed v0.15.0), a9k.1 spec | Status tracking in bridge; `pendingPermissions` always `[]` |
| a9k.3 | `session/transcript` | a9k.1 spec | Read-only session-store query; independent of a9k.2 |
| a9k.4 | `session/state_changed` trigger 3 (`currentTurnIndex`) | a9k.2, a9k.3 | Wire session-store writes to push notifications |
| a9k.6 | `pendingPermissions` populated | a9k.2 | Bridge-level permission tracking; kanban stops mirroring |

---

## Shared TypeScript types (to be added to `src/channels/acp/types.ts`)

```typescript
// SessionStatus and derived types

export type SessionStatus = 'idle' | 'in_progress' | 'error' | 'unknown';

export interface PendingPermission {
  requestId: string;
  kind: string;
  toolCallId?: string;
  requestedAt: string; // ISO 8601 UTC
}

export interface SessionState {
  id: string;
  agent: string | null;
  status: SessionStatus;
  currentTurnIndex: number;
  pendingPermissions: PendingPermission[];
  updatedAt: string; // ISO 8601 UTC
}

// session/get

export interface SessionGetParams {
  sessionId: string;
}

export type SessionGetResult = SessionState;

// session/list

export interface SessionListParams {}

export interface SessionListResult {
  sessions: SessionState[];
}

// session/transcript

export interface SessionTranscriptParams {
  sessionId: string;
  since?: number;   // default 0
  limit?: number;   // default 200, max 500
}

export interface Turn {
  turnIndex: number;
  userMessage: string | null;
  assistantResponse: string | null;
  timestamp: string;
}

export interface SessionTranscriptResult {
  sessionId: string;
  turns: Turn[];
  hasMore: boolean;
}

// session/subscribe

export interface SessionSubscribeParams {
  sessionId: string;
}

export interface SessionSubscribeResult {
  subscribed: true;
  sessionId: string;
}

// session/unsubscribe

export interface SessionUnsubscribeParams {
  sessionId: string;
}

export interface SessionUnsubscribeResult {}

// Server-sent notification

export interface SessionStateChangedNotification extends JsonRpcNotification {
  method: 'session/state_changed';
  params: SessionState;
}
```

---

## Reconnect flow (client recipe)

On WS reconnect for a card with a known `session_id`:

```
1. session/get { sessionId }
   -> if -32001 (not found): session was lost. Show "session lost" UI. Done.
   -> if status "unknown": session may be stale. Proceed to step 2.
   -> capture bridgeTurnIndex = result.currentTurnIndex

2. If bridgeTurnIndex > kanban.lastRenderedTurnIndex:
   session/transcript { sessionId, since: kanban.lastRenderedTurnIndex + 1 }
   -> apply returned turns to card_comments table
   -> update kanban.lastRenderedTurnIndex = last turn's turnIndex

3. session/subscribe { sessionId }
   -> replace local session state on each session/state_changed push going forward

4. If status was "in_progress" (or becomes so via push):
   -> render "agent is thinking" indicator
   -> wait for session/state_changed with status "idle"
```

If `kanban.lastRenderedTurnIndex` is -1 (empty card), pass `since: 0` in step 2
to fetch the full transcript. Wire cost is zero for sessions with no turns.

---

## References

- Bill's architectural doc: `workspaces/bill/research/bridge-authoritative-session-state.md`
- Existing ACP types: `src/channels/acp/types.ts`
- Connection handler: `src/channels/acp/connection-handler.ts`
- Bridge session registry: `src/core/bridge.ts` (`botSessionRegistry`, `forceResumeSession`)
- Session-store schema: `~/.copilot/session-store.db` (`turns` table, `turn_index` is 0-based)
- Beads task: `copilot-a9k.1`
