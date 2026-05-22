# A2A Channel Adapter

The A2A channel adapter exposes copilot-bridge agents over the [Agent2Agent (A2A) Protocol v1.0.0](https://a2aproject.github.io/A2A/latest/specification/), the open standard under the Linux Foundation for interoperable AI agent communication. It uses the JSON-RPC 2.0 over HTTP + SSE protocol binding, one of three first-class bindings defined in the spec (alongside gRPC and HTTP+JSON/REST).

Use the A2A adapter when you want any A2A-compliant client - other agents, web UIs, third-party tooling - to interact with copilot-bridge agents without custom client code.

> **Note on the existing WS channel:** `channels/acp/` (to be renamed `channels/copilot-bridge-ws-rpc/`) is a custom internal WebSocket JSON-RPC protocol. It is not A2A-compliant. It remains supported for internal clients (e.g. kanban) and will be deprecated once the A2A channel covers all use cases.

## Table of Contents

- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [Discovery - Agent Card](#discovery---agent-card)
- [JSON-RPC Endpoint](#json-rpc-endpoint)
- [Operations](#operations)
  - [SendMessage](#sendmessage)
  - [SendStreamingMessage](#sendstreamingmessage)
  - [GetTask](#gettask)
  - [CancelTask](#canceltask)
  - [SubscribeToTask](#subscribetotask)
  - [CreateTaskPushNotificationConfig](#createtaskpushnotificationconfig)
  - [GetTaskPushNotificationConfig](#gettaskpushnotificationconfig)
  - [ListTasks](#listtasks)
- [Task Lifecycle](#task-lifecycle)
- [Streaming - SSE](#streaming---sse)
- [HITL - Permission Approval](#hitl---permission-approval)
- [Push Notifications](#push-notifications)
- [Multi-turn Sessions](#multi-turn-sessions)
- [Reconnect and Resume](#reconnect-and-resume)
- [Multi-agent Discovery](#multi-agent-discovery)
- [Error Codes](#error-codes)
- [Protocol Gaps and Solutions](#protocol-gaps-and-solutions)
- [Implementation Notes](#implementation-notes)

---

## Quick Start

### 1. Configure

Add an `a2a` platform to your `config.json`:

```json
{
  "platforms": {
    "a2a": {
      "enabled": true,
      "bind": "127.0.0.1",
      "port": 7880,
      "bots": {
        "copilot": { "token": "bot-internal-token", "agent": "copilot" }
      },
      "apiKeys": {
        "dev-key": {
          "secret": "env:A2A_API_KEY",
          "allowedAgents": ["*"]
        }
      }
    }
  }
}
```

Set the secret in your environment or `.env` file:

```bash
export A2A_API_KEY="my-secret-key-here"
```

### 2. Start the bridge

```bash
copilot-bridge start
```

Verify the A2A server is up:

```bash
curl http://localhost:7880/healthz
# {"status":"ok","protocol":"a2a","version":"1.0.0"}
```

### 3. Discover agents

```bash
# Single agent card (standard A2A)
curl http://localhost:7880/agents/copilot/.well-known/agent-card.json

# All agents (bridge extension - see Multi-agent Discovery)
curl -H "Authorization: Bearer my-secret-key-here" \
  http://localhost:7880/agents
```

### 4. Send a message and stream the response

```bash
curl -X POST http://localhost:7880/agents/copilot \
  -H "Authorization: Bearer my-secret-key-here" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "SendStreamingMessage",
    "params": {
      "message": {
        "role": "user",
        "parts": [{ "kind": "text", "text": "List the files in the current directory" }]
      }
    }
  }'
```

---

## Configuration

The A2A platform is configured under `platforms.a2a` in `config.json`.

### Full Reference

```json
{
  "platforms": {
    "a2a": {
      "enabled": true,
      "bind": "127.0.0.1",
      "port": 7880,
      "bots": {
        "copilot": {
          "token": "internal-bot-token",
          "agent": "copilot",
          "model": "claude-sonnet-4.6"
        },
        "bob": {
          "token": "another-bot-token",
          "agent": "bob",
          "model": "claude-opus-4.7"
        }
      },
      "apiKeys": {
        "dev-key": {
          "secret": "env:A2A_API_KEY",
          "allowedAgents": ["*"]
        },
        "readonly-key": {
          "secret": "env:A2A_READONLY_KEY",
          "allowedAgents": ["copilot"]
        }
      },
      "pushNotifications": {
        "enabled": true,
        "verifyWebhook": true
      }
    }
  }
}
```

| Field | Default | Description |
|---|---|---|
| `enabled` | `false` | Enable the A2A platform |
| `bind` | `127.0.0.1` | Interface to bind. Use `0.0.0.0` to expose externally. |
| `port` | `7880` | HTTP port |
| `bots` | `{}` | Agent definitions (same schema as other platforms) |
| `apiKeys` | `{}` | API key definitions |
| `pushNotifications.enabled` | `true` | Allow clients to register push notification webhooks |
| `pushNotifications.verifyWebhook` | `true` | Verify webhook reachability before accepting registration |

---

## Authentication

All requests (except `/.well-known/agent-card.json`) require a bearer token:

```
Authorization: Bearer <api-key-secret>
```

The token is matched against `platforms.a2a.apiKeys`. Each key may restrict which agents it can access via `allowedAgents`. Requests to agents outside that list return `401`.

---

## Discovery - Agent Card

The A2A spec requires each agent to publish its capabilities at `/.well-known/agent-card.json`.

### Per-agent card (spec-standard)

```
GET /agents/{agentName}/.well-known/agent-card.json
```

No authentication required (public endpoint per spec).

```json
{
  "name": "copilot",
  "description": "GitHub Copilot coding agent",
  "url": "http://localhost:7880/agents/copilot",
  "version": "1.0.0",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true,
    "stateTransitionHistory": false,
    "extensions": []
  },
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "securitySchemes": {
    "bearer": {
      "type": "http",
      "scheme": "bearer"
    }
  },
  "security": [{ "bearer": [] }],
  "skills": [
    {
      "id": "coding",
      "name": "Coding",
      "description": "Write, review, and debug code",
      "tags": ["code", "git", "terminal"]
    }
  ]
}
```

### All-agents list (bridge extension)

Because bridge multiplexes N agents through a single server, it also exposes a list endpoint for multi-agent discovery. This is a bridge-level convenience - not part of the A2A spec:

```
GET /agents
Authorization: Bearer <api-key>
```

```json
{
  "agents": [
    { "name": "copilot", "agentCardUrl": "http://localhost:7880/agents/copilot/.well-known/agent-card.json" },
    { "name": "bob",     "agentCardUrl": "http://localhost:7880/agents/bob/.well-known/agent-card.json" }
  ]
}
```

Clients SHOULD use the per-agent `/.well-known/agent-card.json` URL as their canonical reference. The list endpoint is for initial discovery only.

---

## JSON-RPC Endpoint

All A2A operations are sent as JSON-RPC 2.0 requests to the agent's base URL:

```
POST /agents/{agentName}
Content-Type: application/json
Authorization: Bearer <api-key>
```

For streaming operations, add:

```
Accept: text/event-stream
```

The server responds with `Content-Type: text/event-stream` for `SendStreamingMessage` and `SubscribeToTask`. All other operations respond with `Content-Type: application/json`.

---

## Operations

### SendMessage

Send a message and wait for the task to reach a terminal or interrupted state before returning.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "SendMessage",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "Summarize the README" }]
    },
    "configuration": {
      "returnImmediately": false
    }
  }
}
```

Set `returnImmediately: true` to return a `TASK_STATE_WORKING` task immediately instead of blocking.

**Response:** A `Task` object at its final or interrupted state.

---

### SendStreamingMessage

Send a message and stream updates in real time over SSE.

**Request:** Same shape as `SendMessage`.

**Response:** `Content-Type: text/event-stream`. Each SSE event is a JSON-encoded `StreamResponse`:

```
data: {"task": {"id": "abc123", "status": {"state": "TASK_STATE_SUBMITTED"}, ...}}

data: {"statusUpdate": {"taskId": "abc123", "status": {"state": "TASK_STATE_WORKING"}, "final": false}}

data: {"artifactUpdate": {"taskId": "abc123", "artifact": {"parts": [{"kind": "text", "text": "Here is the summary..."}]}, "append": true, "lastChunk": false}}

data: {"statusUpdate": {"taskId": "abc123", "status": {"state": "TASK_STATE_COMPLETED"}, "final": true}}
```

The stream closes when the task reaches a terminal state (`TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, `TASK_STATE_CANCELED`) or an interrupted state (`TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_AUTH_REQUIRED`).

**Persist the `taskId`.** You will need it to resume after `TASK_STATE_INPUT_REQUIRED` or after a disconnect.

---

### GetTask

Retrieve the current state of a task.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "GetTask",
  "params": {
    "id": "abc123",
    "historyLength": 0
  }
}
```

Returns the `Task` object. Use `historyLength > 0` to include previous message turns in the response.

---

### CancelTask

Cancel a running task.

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "CancelTask",
  "params": { "id": "abc123" }
}
```

Returns the updated `Task`. Cancellation is best-effort - the task may have already completed.

---

### SubscribeToTask

Reattach an SSE stream to an existing task that is still in progress.

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "SubscribeToTask",
  "params": { "id": "abc123" }
}
```

The server MUST emit the current `Task` state as the first SSE event, then stream subsequent updates. This prevents any gap between your last known state and the resubscription.

Use this after a network drop or when a user reopens a card that was running in the background.

---

### CreateTaskPushNotificationConfig

Register a webhook to receive task state changes asynchronously.

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "CreateTaskPushNotificationConfig",
  "params": {
    "taskId": "abc123",
    "pushNotificationConfig": {
      "url": "https://myapp.example.com/api/a2a/notifications",
      "token": "optional-hmac-token"
    }
  }
}
```

Returns the created `PushNotificationConfig` with an assigned `id`. Bridge will POST `StreamResponse` payloads to the webhook URL on every task state transition, including `TASK_STATE_INPUT_REQUIRED`.

See [Push Notifications](#push-notifications) for the full webhook flow.

---

### GetTaskPushNotificationConfig

Retrieve an existing push notification config.

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "GetTaskPushNotificationConfig",
  "params": { "taskId": "abc123", "pushNotificationConfigId": "cfg-xyz" }
}
```

---

### ListTasks

List tasks with optional filtering. Tasks are sorted by last update time descending.

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "ListTasks",
  "params": {
    "filter": {
      "state": "TASK_STATE_INPUT_REQUIRED"
    },
    "pageSize": 20,
    "pageToken": ""
  }
}
```

Returns a `ListTasksResponse` with `tasks[]` and `nextPageToken` (empty string when no more pages).

---

## Task Lifecycle

Tasks progress through the following states. Wire format is SCREAMING_SNAKE_CASE as defined in the A2A proto spec (§4.1.3).

```
TASK_STATE_SUBMITTED -> TASK_STATE_WORKING -> TASK_STATE_COMPLETED
                                           -> TASK_STATE_FAILED
                                           -> TASK_STATE_CANCELED
                                           -> TASK_STATE_REJECTED
                                           -> TASK_STATE_INPUT_REQUIRED -> TASK_STATE_WORKING (after approval)
                                           -> TASK_STATE_AUTH_REQUIRED  -> TASK_STATE_WORKING (after credentials)
```

### Mapping from SDK events

| Copilot SDK event | A2A task state |
|---|---|
| Session accepted | `TASK_STATE_SUBMITTED` |
| Agent begins processing | `TASK_STATE_WORKING` |
| Tool call triggered (permission needed) | `TASK_STATE_INPUT_REQUIRED` |
| Permission resolved | `TASK_STATE_WORKING` |
| Agent finishes response | `TASK_STATE_COMPLETED` |
| Session error | `TASK_STATE_FAILED` |
| Client cancels | `TASK_STATE_CANCELED` |

### `TASK_STATE_INPUT_REQUIRED` payload

When a task enters `TASK_STATE_INPUT_REQUIRED`, the `TaskStatus.message` carries the details the client needs to render the approval UI. The `data` part shape shown below (`kind: "permission_request"`) is a bridge convention for encoding tool permission requests - it is not part of the A2A spec. The spec allows arbitrary `Parts` in a status message.

```json
{
  "status": {
    "state": "TASK_STATE_INPUT_REQUIRED",
    "message": {
      "role": "agent",
      "parts": [
        {
          "kind": "text",
          "text": "Permission required: bash"
        },
        {
          "kind": "data",
          "data": {
            "kind": "permission_request",
            "tool": "bash",
            "summary": "Run shell command",
            "details": { "command": "git status" }
          }
        }
      ]
    }
  }
}
```

---

## Streaming - SSE

`SendStreamingMessage` and `SubscribeToTask` both return `Content-Type: text/event-stream`.

### Event types

| Event field | When emitted |
|---|---|
| `task` | First event on `SendStreamingMessage` - the initial Task object |
| `statusUpdate` | Task state changes (`TASK_STATE_WORKING`, `TASK_STATE_INPUT_REQUIRED`, `TASK_STATE_COMPLETED`, etc.) |
| `artifactUpdate` | Streaming content chunks and tool call trajectory data |

### Tool call trajectory in artifacts

Tool call progress is surfaced as artifact updates with a `trajectory` metadata part:

```
data: {"artifactUpdate": {
  "taskId": "abc123",
  "artifact": {
    "parts": [
      {
        "kind": "data",
        "data": {
          "kind": "tool_start",
          "toolName": "bash",
          "toolCallId": "tc-001",
          "input": { "command": "git status" }
        }
      }
    ]
  },
  "append": true,
  "lastChunk": false
}}
```

Followed by `tool_complete` or `tool_error` when the tool call finishes. Clients can reconstruct the full tool call trajectory from these events.

### Heartbeats

Bridge emits a comment line (`: keep-alive`) every 15 seconds on idle streams to prevent proxy timeouts. This is bridge implementation behavior - the A2A spec does not prescribe keepalive cadence.

---

## HITL - Permission Approval

This is the full flow when an agent hits a tool permission gate, entirely within the A2A spec.

### SSE path (stream is open)

```
client                               bridge
  |                                    |
  |-- SendStreamingMessage ----------------->|
  |<-- SSE: task(TASK_STATE_WORKING) -------------|
  |<-- SSE: artifact(tool_start) ------|
  |<-- SSE: statusUpdate --------------|  <- task goes TASK_STATE_INPUT_REQUIRED
  |    state: TASK_STATE_INPUT_REQUIRED           |
  |    message: {tool, details}        |
  |                                    |
  | [render approval UI]               |
  |                                    |
  |-- SendMessage (taskId) ---------->|  <- approval decision
  |    message: "approved"             |
  |                                    |
  |<-- SSE: statusUpdate --------------|  <- task back to TASK_STATE_WORKING
  |    state: TASK_STATE_WORKING                  |
  |<-- SSE: artifact(tool_complete) ---|
  |<-- SSE: artifact(text chunks) -----|
  |<-- SSE: statusUpdate --------------|
  |    state: TASK_STATE_COMPLETED (final: true)  |
  | [SSE closes]                       |
```

### Push notification path (stream is closed)

```
client                               bridge
  |                                    |
  | [stream closed / user navigated away]
  |                                    |
  |<-- POST /api/a2a/notifications ----|  <- push notification
  |    { taskId, state: TASK_STATE_INPUT_REQUIRED |
  |      message: {tool, details} }    |
  |                                    |
  | [render approval banner]           |
  |                                    |
  |-- SendMessage (taskId) ---------->|  <- approval decision
  |-- SubscribeToTask (taskId) ----->|  <- reattach stream
  |<-- SSE: task(current state) -------|
  |<-- SSE: statusUpdate(TASK_STATE_WORKING) -----|
  | [stream resumes]                   |
```

### Sending the approval decision

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "SendMessage",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "approved" }]
    },
    "configuration": {
      "taskId": "abc123"
    }
  }
}
```

To deny: send `"denied"` or `"deny"` as the text part.

---

## Push Notifications

Push notifications let bridge reach your server even when no SSE connection is open.

### Setup

Register a webhook after creating a task (or you can register before dispatching using `SendMessage` with `returnImmediately: true`):

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "CreateTaskPushNotificationConfig",
  "params": {
    "taskId": "abc123",
    "pushNotificationConfig": {
      "url": "https://yourserver.example.com/api/a2a/notifications",
      "token": "env:PUSH_NOTIFICATION_SECRET"
    }
  }
}
```

The `token` is included as `X-A2A-Notification-Token` on every POST. Verify it server-side to authenticate bridge.

### Webhook payload

Bridge POSTs a `StreamResponse`-shaped body on every task state transition:

```json
{
  "statusUpdate": {
    "taskId": "abc123",
    "status": {
      "state": "TASK_STATE_INPUT_REQUIRED",
      "message": {
        "role": "agent",
        "parts": [
          { "kind": "text", "text": "Permission required: bash" },
          { "kind": "data", "data": { "kind": "permission_request", "tool": "bash", "summary": "Run shell command", "details": { "command": "git status" } } }
        ]
      }
    },
    "final": false
  }
}
```

Your webhook endpoint MUST return `HTTP 200` within 5 seconds. Bridge will retry up to 3 times with exponential backoff on non-2xx responses.

### State transitions that trigger a push

- `TASK_STATE_WORKING` (task starts)
- `TASK_STATE_INPUT_REQUIRED` (permission needed - the primary use case)
- `TASK_STATE_AUTH_REQUIRED` (credentials needed)
- `TASK_STATE_COMPLETED`
- `TASK_STATE_FAILED`
- `TASK_STATE_CANCELED`

---

## Multi-turn Sessions

A2A uses `contextId` to group related tasks into a logical session. Tasks with the same `contextId` are routed to the same underlying copilot session in bridge.

### Starting a new session

Omit `contextId` (or let the client generate one) on the first `SendMessage` or `SendStreamingMessage`. Bridge creates a new session and returns the `contextId` in the `Task` response.

### Continuing a session

Pass the `contextId` from the previous task. Per A2A spec §3.4.3, `contextId` belongs on the `Message` object:

```json
{
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "Now refactor that function" }],
      "contextId": "ctx-session-abc"
    }
  }
}
```

Bridge routes this to the existing session, preserving conversation history.

---

## Reconnect and Resume

### After a network drop

```
1. GetTask(taskId)
   -> check current state
   -> if TASK_STATE_INPUT_REQUIRED: render approval UI immediately (no SSE needed)
   -> if TASK_STATE_WORKING: proceed to step 2

2. SubscribeToTask(taskId)
   -> opens new SSE stream
   -> first event is current Task state (spec guarantee - no gap)
   -> subsequent events continue the live stream
```

### After the bridge restarts

Bridge persists task state to disk. On restart, in-flight tasks are marked `TASK_STATE_FAILED` with a descriptive error message. Clients detect this via `GetTask` or the push notification webhook.

To re-run a task after a bridge restart: send a new `SendStreamingMessage` with the same `contextId`. If the session was persisted, the bridge may be able to resume it; if not, a new session is created.

---

## Multi-agent Discovery

Bridge runs N agents through a single HTTP server. Routing is by URL path:

| URL pattern | Routes to |
|---|---|
| `/agents/copilot` | `copilot` agent |
| `/agents/bob` | `bob` agent |
| `/agents/copilot/.well-known/agent-card.json` | copilot's agent card |
| `/agents` | list of all agents (bridge extension) |

Each agent has its own independent task namespace. A `taskId` created under `/agents/copilot` is not visible under `/agents/bob`.

---

## Error Codes

Standard A2A JSON-RPC error codes:

| Code | Name | Description |
|---|---|---|
| `-32700` | `ParseError` | Invalid JSON |
| `-32600` | `InvalidRequest` | Malformed JSON-RPC request |
| `-32601` | `MethodNotFound` | Unknown JSON-RPC method |
| `-32602` | `InvalidParams` | Missing or invalid parameters |
| `-32603` | `InternalError` | Unhandled server error |
| `-32001` | `TaskNotFound` | Task ID does not exist |
| `-32002` | `TaskNotCancelable` | Task is in a terminal state |
| `-32003` | `PushNotificationNotSupported` | Push notifications disabled in config |
| `-32004` | `UnsupportedOperation` | Operation not supported (e.g. streaming not accepted) |
| `-32005` | `ContentTypeNotSupported` | Unsupported part media type |

---

## Protocol Gaps and Solutions

This section documents the three requirements that were identified as potential blockers when migrating from the custom `copilot-bridge-ws-rpc` channel to A2A, and how each is resolved.

### Gap 1: Session reconnect

**Concern:** Custom WS channel had explicit `session/resume` logic. What happens when a client disconnects mid-run?

**A2A solution: `SubscribeToTask` - fully in spec.**

The client persists the `taskId`. On reconnect:
1. `tasks/get(taskId)` - snapshot current state, detect if `TASK_STATE_INPUT_REQUIRED` was missed
2. `tasks/resubscribe(taskId)` - opens new SSE stream; spec REQUIRES the first event to be the current Task state

No gap. No custom bridge work needed.

---

### Gap 2: Live views of sessions

This breaks into two sub-cases.

#### 2a. Single-task live view (what is this agent doing right now)

**A2A solution: `SendStreamingMessage` SSE - fully in spec.**

`artifactUpdate` events carry streaming text chunks and tool call trajectory as data Parts. `statusUpdate` events carry state transitions including `TASK_STATE_INPUT_REQUIRED`. `SubscribeToTask` reattaches after a drop.

No gap. No custom bridge work needed.

#### 2b. Board-level live view (all agents, all tasks simultaneously)

**Gap: A2A has no "subscribe to all tasks" operation.** `ListTasks` is snapshot-only.

**Solution: push notifications per task, aggregated by kanban server. No custom bridge endpoint required.**

The architecture:
```
bridge ----POST /api/a2a/notifications----> kanban server   (on every task state change)
kanban server aggregates all task state into its own board model
kanban server serves its own SSE stream to the browser
browser watches kanban server, not bridge directly
```

Push notifications (`CreateTaskPushNotificationConfig`) are spec-native. Kanban registers a webhook. Bridge POSTs a `StreamResponse` payload on every task state transition for every task. Kanban server owns board state aggregation. This is an architectural responsibility, not a protocol gap - the same pattern used by any A2A client that needs to track multiple tasks.

**Bridge stays pure A2A. Kanban server owns the board.**

---

### Gap 3: Serving multiple agents from one server

**Gap: A2A spec defines one agent per server (`/.well-known/agent-card.json`). No multi-agent routing is defined.**

**Solution: URL-path routing. Each per-agent path is a fully A2A-compliant endpoint. `GET /agents` is the only non-spec addition.**

Bridge routes by URL path (`/agents/copilot`, `/agents/bob`). Each path is a complete, independent A2A server - its own agent card, its own task namespace, its own JSON-RPC endpoint. The routing is plain HTTP and does not touch A2A operation semantics.

`GET /agents` (returning a list of agent names and card URLs) is a bridge-level discovery convenience. It is not an A2A operation and does not affect compliance of the per-agent endpoints.

---

### Net result

| Requirement | Spec-native solution | Custom bridge work |
|---|---|---|
| Session reconnect | `SubscribeToTask` | None |
| Single-task live view | `SendStreamingMessage` SSE | None |
| Board-level live view | Push notifications per task; kanban aggregates | None - kanban owns it |
| Multiple agents from one server | URL-path routing | `GET /agents` list only |

**Bridge `channels/a2a/` can be 100% A2A v1.0.0 compliant.** No separate non-A2A HTTP/WS/SSE endpoint is required. `GET /agents` is the only bridge addition and it does not modify any A2A operation.

---

## Implementation Notes

### Spec compliance target

The A2A channel implementation in `src/channels/a2a/` MUST conform to A2A v1.0.0 with zero custom extensions on the protocol layer. The `GET /agents` list endpoint is the single bridge-level addition; it uses a separate URL path and does not modify any A2A operation semantics.

### What is intentionally NOT in this channel

- No card/checkpoint/label system (that is the kanban app's concern)
- No custom WebSocket transport (A2A uses HTTP + SSE only)
- No session subscription push in the WS-RPC style (replaced by `SubscribeToTask` + push notifications)
- No bridge-specific JSON-RPC methods beyond the A2A operation set

### Relation to `channels/copilot-bridge-ws-rpc/`

The WS-RPC channel (`channels/acp/`, to be renamed) remains for internal clients that depend on it. It is not modified by this implementation. Once the A2A channel covers all use cases, the WS-RPC channel will be deprecated and removed.

### Auth note

`/.well-known/agent-card.json` is intentionally unauthenticated per the A2A spec. All other endpoints require a bearer token.

### Spec references

- Full specification: <https://a2aproject.github.io/A2A/latest/specification/>
- Streaming and async: <https://a2aproject.github.io/A2A/latest/topics/streaming-and-async/>
- Key concepts: <https://a2aproject.github.io/A2A/latest/topics/key-concepts/>
- JS SDK (reference client): <https://github.com/a2aproject/a2a-js>
- Python SDK (reference server): <https://github.com/a2aproject/a2a-python>

### Tracked work

- Issue #232: Initial implementation
- Issue #231: WS-RPC channel rename (prerequisite cleanup)
