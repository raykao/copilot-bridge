# A2A Channel Adapter

The A2A channel adapter exposes copilot-bridge agents over the [Agent2Agent (A2A) Protocol v1.0.0](https://a2aproject.github.io/A2A/latest/specification/), the open standard under the Linux Foundation for interoperable AI agent communication. It uses the JSON-RPC 2.0 over HTTP + SSE protocol binding defined in the spec.

Use the A2A adapter when you want any A2A-compliant client - other agents, web UIs, third-party tooling - to interact with copilot-bridge agents without custom client code.

> **Note on the existing WS channel:** `channels/acp/` (to be renamed `channels/copilot-bridge-ws-rpc/`) is a custom internal WebSocket JSON-RPC protocol. It is not A2A-compliant. It remains supported for internal clients (e.g. kanban) and will be deprecated once the A2A channel covers all use cases.

## Table of Contents

- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Authentication](#authentication)
- [Discovery - Agent Card](#discovery---agent-card)
- [JSON-RPC Endpoint](#json-rpc-endpoint)
- [Operations](#operations)
  - [message/send](#messagesend)
  - [message/stream](#messagestream)
  - [tasks/get](#tasksget)
  - [tasks/cancel](#taskscancel)
  - [tasks/resubscribe](#tasksresubscribe)
  - [tasks/pushNotificationConfig/set](#taskspushnotificationconfigset)
  - [tasks/pushNotificationConfig/get](#taskspushnotificationconfigget)
  - [tasks/list](#taskslist)
- [Task Lifecycle](#task-lifecycle)
- [Streaming - SSE](#streaming---sse)
- [HITL - Permission Approval](#hitl---permission-approval)
- [Push Notifications](#push-notifications)
- [Multi-turn Sessions](#multi-turn-sessions)
- [Reconnect and Resume](#reconnect-and-resume)
- [Multi-agent Discovery](#multi-agent-discovery)
- [Error Codes](#error-codes)
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
curl http://localhost:7880/agents/copilot/.well-known/agent.json

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
    "method": "message/stream",
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

All requests (except `/.well-known/agent.json`) require a bearer token:

```
Authorization: Bearer <api-key-secret>
```

The token is matched against `platforms.a2a.apiKeys`. Each key may restrict which agents it can access via `allowedAgents`. Requests to agents outside that list return `401`.

---

## Discovery - Agent Card

The A2A spec requires each agent to publish its capabilities at `/.well-known/agent.json`.

### Per-agent card (spec-standard)

```
GET /agents/{agentName}/.well-known/agent.json
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
    { "name": "copilot", "agentCardUrl": "http://localhost:7880/agents/copilot/.well-known/agent.json" },
    { "name": "bob",     "agentCardUrl": "http://localhost:7880/agents/bob/.well-known/agent.json" }
  ]
}
```

Clients SHOULD use the per-agent `/.well-known/agent.json` URL as their canonical reference. The list endpoint is for initial discovery only.

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

The server responds with `Content-Type: text/event-stream` for `message/stream` and `tasks/resubscribe`. All other operations respond with `Content-Type: application/json`.

---

## Operations

### message/send

Send a message and wait for the task to reach a terminal or interrupted state before returning.

**Request:**

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "Summarize the README" }]
    },
    "configuration": {
      "return_immediately": false
    }
  }
}
```

Set `return_immediately: true` to return a `working` task immediately instead of blocking.

**Response:** A `Task` object at its final or interrupted state.

---

### message/stream

Send a message and stream updates in real time over SSE.

**Request:** Same shape as `message/send`.

**Response:** `Content-Type: text/event-stream`. Each SSE event is a JSON-encoded `StreamResponse`:

```
data: {"task": {"id": "abc123", "status": {"state": "submitted"}, ...}}

data: {"taskStatusUpdateEvent": {"taskId": "abc123", "status": {"state": "working"}, "final": false}}

data: {"taskArtifactUpdateEvent": {"taskId": "abc123", "artifact": {"parts": [{"kind": "text", "text": "Here is the summary..."}]}, "append": true, "lastChunk": false}}

data: {"taskStatusUpdateEvent": {"taskId": "abc123", "status": {"state": "completed"}, "final": true}}
```

The stream closes when the task reaches a terminal state (`completed`, `failed`, `canceled`) or an interrupted state (`input-required`, `auth-required`).

**Persist the `taskId`.** You will need it to resume after `input-required` or after a disconnect.

---

### tasks/get

Retrieve the current state of a task.

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tasks/get",
  "params": {
    "id": "abc123",
    "historyLength": 0
  }
}
```

Returns the `Task` object. Use `historyLength > 0` to include previous message turns in the response.

---

### tasks/cancel

Cancel a running task.

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tasks/cancel",
  "params": { "id": "abc123" }
}
```

Returns the updated `Task`. Cancellation is best-effort - the task may have already completed.

---

### tasks/resubscribe

Reattach an SSE stream to an existing task that is still in progress.

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tasks/resubscribe",
  "params": { "id": "abc123" }
}
```

The server MUST emit the current `Task` state as the first SSE event, then stream subsequent updates. This prevents any gap between your last known state and the resubscription.

Use this after a network drop or when a user reopens a card that was running in the background.

---

### tasks/pushNotificationConfig/set

Register a webhook to receive task state changes asynchronously.

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tasks/pushNotificationConfig/set",
  "params": {
    "taskId": "abc123",
    "pushNotificationConfig": {
      "url": "https://myapp.example.com/api/a2a/notifications",
      "token": "optional-hmac-token"
    }
  }
}
```

Returns the created `PushNotificationConfig` with an assigned `id`. Bridge will POST `StreamResponse` payloads to the webhook URL on every task state transition, including `input-required`.

See [Push Notifications](#push-notifications) for the full webhook flow.

---

### tasks/pushNotificationConfig/get

Retrieve an existing push notification config.

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tasks/pushNotificationConfig/get",
  "params": { "taskId": "abc123", "pushNotificationConfigId": "cfg-xyz" }
}
```

---

### tasks/list

List tasks with optional filtering. Tasks are sorted by last update time descending.

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tasks/list",
  "params": {
    "filter": {
      "state": "input-required"
    },
    "pageSize": 20,
    "pageToken": ""
  }
}
```

Returns a `ListTasksResponse` with `tasks[]` and `nextPageToken` (empty string when no more pages).

---

## Task Lifecycle

Tasks progress through the following states:

```
submitted -> working -> completed
                     -> failed
                     -> canceled
                     -> input-required -> working (after client sends approval)
                     -> auth-required  -> working (after client sends credentials)
```

### Mapping from SDK events

| Copilot SDK event | A2A task state |
|---|---|
| Session accepted | `submitted` |
| Agent begins processing | `working` |
| Tool call triggered (permission needed) | `input-required` |
| Permission resolved | `working` |
| Agent finishes response | `completed` |
| Session error | `failed` |
| Client cancels | `canceled` |

### `input-required` payload

When a task enters `input-required`, the `TaskStatus.message` carries the details the client needs to render the approval UI:

```json
{
  "status": {
    "state": "input-required",
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

`message/stream` and `tasks/resubscribe` both return `Content-Type: text/event-stream`.

### Event types

| Event field | When emitted |
|---|---|
| `task` | First event on `message/stream` - the initial Task object |
| `taskStatusUpdateEvent` | Task state changes (`working`, `input-required`, `completed`, etc.) |
| `taskArtifactUpdateEvent` | Streaming content chunks and tool call trajectory data |

### Tool call trajectory in artifacts

Tool call progress is surfaced as artifact updates with a `trajectory` metadata part:

```
data: {"taskArtifactUpdateEvent": {
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

Bridge emits a comment line (`: keep-alive`) every 15 seconds on idle streams to prevent proxy timeouts.

---

## HITL - Permission Approval

This is the full flow when an agent hits a tool permission gate, entirely within the A2A spec.

### SSE path (stream is open)

```
client                               bridge
  |                                    |
  |-- message/stream ----------------->|
  |<-- SSE: task(working) -------------|
  |<-- SSE: artifact(tool_start) ------|
  |<-- SSE: statusUpdate --------------|  <- task goes input-required
  |    state: input-required           |
  |    message: {tool, details}        |
  |                                    |
  | [render approval UI]               |
  |                                    |
  |-- message/send (taskId) ---------->|  <- approval decision
  |    message: "approved"             |
  |                                    |
  |<-- SSE: statusUpdate --------------|  <- task back to working
  |    state: working                  |
  |<-- SSE: artifact(tool_complete) ---|
  |<-- SSE: artifact(text chunks) -----|
  |<-- SSE: statusUpdate --------------|
  |    state: completed (final: true)  |
  | [SSE closes]                       |
```

### Push notification path (stream is closed)

```
client                               bridge
  |                                    |
  | [stream closed / user navigated away]
  |                                    |
  |<-- POST /api/a2a/notifications ----|  <- push notification
  |    { taskId, state: input-required |
  |      message: {tool, details} }    |
  |                                    |
  | [render approval banner]           |
  |                                    |
  |-- message/send (taskId) ---------->|  <- approval decision
  |-- tasks/resubscribe (taskId) ----->|  <- reattach stream
  |<-- SSE: task(current state) -------|
  |<-- SSE: statusUpdate(working) -----|
  | [stream resumes]                   |
```

### Sending the approval decision

```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "message/send",
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

Register a webhook after creating a task (or you can register before dispatching using `message/send` with `return_immediately: true`):

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tasks/pushNotificationConfig/set",
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
  "taskStatusUpdateEvent": {
    "taskId": "abc123",
    "status": {
      "state": "input-required",
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

- `working` (task starts)
- `input-required` (permission needed - the primary use case)
- `auth-required` (credentials needed)
- `completed`
- `failed`
- `canceled`

---

## Multi-turn Sessions

A2A uses `contextId` to group related tasks into a logical session. Tasks with the same `contextId` are routed to the same underlying copilot session in bridge.

### Starting a new session

Omit `contextId` (or let the client generate one) on the first `message/send` or `message/stream`. Bridge creates a new session and returns the `contextId` in the `Task` response.

### Continuing a session

Pass the `contextId` from the previous task:

```json
{
  "params": {
    "message": {
      "role": "user",
      "parts": [{ "kind": "text", "text": "Now refactor that function" }]
    },
    "configuration": {
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
1. tasks/get(taskId)
   -> check current state
   -> if input-required: render approval UI immediately (no SSE needed)
   -> if working: proceed to step 2

2. tasks/resubscribe(taskId)
   -> opens new SSE stream
   -> first event is current Task state (spec guarantee - no gap)
   -> subsequent events continue the live stream
```

### After the bridge restarts

Bridge persists task state to disk. On restart, in-flight tasks are marked `failed` with a descriptive error message. Clients detect this via `tasks/get` or the push notification webhook.

To re-run a task after a bridge restart: send a new `message/stream` with the same `contextId`. If the session was persisted, the bridge may be able to resume it; if not, a new session is created.

---

## Multi-agent Discovery

Bridge runs N agents through a single HTTP server. Routing is by URL path:

| URL pattern | Routes to |
|---|---|
| `/agents/copilot` | `copilot` agent |
| `/agents/bob` | `bob` agent |
| `/agents/copilot/.well-known/agent.json` | copilot's agent card |
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

## Implementation Notes

### Spec compliance target

The A2A channel implementation in `src/channels/a2a/` MUST conform to A2A v1.0.0 with zero custom extensions on the protocol layer. The `GET /agents` list endpoint is the single bridge-level addition; it uses a separate URL path and does not modify any A2A operation semantics.

### What is intentionally NOT in this channel

- No card/checkpoint/label system (that is the kanban app's concern)
- No custom WebSocket transport (A2A uses HTTP + SSE only)
- No session subscription push in the WS-RPC style (replaced by `tasks/resubscribe` + push notifications)
- No bridge-specific JSON-RPC methods beyond the A2A operation set

### Relation to `channels/copilot-bridge-ws-rpc/`

The WS-RPC channel (`channels/acp/`, to be renamed) remains for internal clients that depend on it. It is not modified by this implementation. Once the A2A channel covers all use cases, the WS-RPC channel will be deprecated and removed.

### Auth note

`/.well-known/agent.json` is intentionally unauthenticated per the A2A spec. All other endpoints require a bearer token.

### Spec references

- Full specification: <https://a2aproject.github.io/A2A/latest/specification/>
- Streaming and async: <https://a2aproject.github.io/A2A/latest/topics/streaming-and-async/>
- Key concepts: <https://a2aproject.github.io/A2A/latest/topics/key-concepts/>
- JS SDK (reference client): <https://github.com/a2aproject/a2a-js>
- Python SDK (reference server): <https://github.com/a2aproject/a2a-python>

### Tracked work

- Issue #232: Initial implementation
- Issue #231: WS-RPC channel rename (prerequisite cleanup)
