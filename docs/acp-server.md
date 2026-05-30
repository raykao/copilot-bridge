# ACP Server (v2)

**Status:** Public preview as of v0.14+ (see commit `774659e` and `432a440`).

copilot-bridge can act as an **Agent Client Protocol (ACP) server**, exposing
each configured agent as its own raw TCP endpoint. ACP clients (IDEs, custom
frontends, work-routing systems like Kanban/SCUT) connect over TCP and drive
agents using standard ACP JSON-RPC.

This is in addition to copilot-bridge's existing messaging-platform channels
(Mattermost, etc.). The same bridge process can serve both.

> [!NOTE]
> ACP v2 replaces an earlier prototype that exposed a single WebSocket
> endpoint with HTTP catalog discovery and per-bot URL paths
> (`ws://host:port/<botname>`). That design has been removed. Each agent now
> listens on its own raw TCP port. Clients that integrated against the old
> WS+catalog design must migrate -- see [Migration from pre-v2](#migration-from-pre-v2).

---

## Overview

```
External ACP Clients                      copilot-bridge process
─────────────────────                     ──────────────────────────────────
ACP client A  ───tcp───► :3030 (bob)   ─┐
ACP client B  ───tcp───► :3031 (homer) ─┼─►  CopilotAgent per connection
ACP client C  ───tcp───► :3032 (bill)  ─┘    │
                                             ▼
                                       CopilotBridge (shared)
                                             │
                                             ▼
                                     @github/copilot-sdk
                                             │
                                             ▼
                                       Copilot CLI subprocess(es)
```

Each agent in `platforms.acp.agents` gets its own dedicated TCP listener.
Connections to a listener are handled by a `CopilotAgent` instance pinned to
that bot's configuration (persona name, working directory, model, etc.).

Multiple ACP clients can connect to the same agent port simultaneously. Each
connection is independent and can host multiple ACP sessions (per the ACP
spec's "many sessions per connection" design).

---

## Configuration

Add a `platforms.acp` block to `config.json`:

```json
{
  "platforms": {
    "acp": {
      "basePort": 3000,
      "bind": "127.0.0.1",
      "agents": {
        "bob":   { "agent": "bob",   "workingDirectory": "/home/me/.copilot-bridge/workspaces/bob",   "port": 3030, "model": "claude-sonnet-4.6" },
        "homer": { "agent": "homer", "workingDirectory": "/home/me/.copilot-bridge/workspaces/homer", "port": 3031 },
        "bill":  { "agent": "bill",  "workingDirectory": "/home/me/.copilot-bridge/workspaces/bill"  }
      }
    }
  }
}
```

### `AcpPlatformConfig` fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `basePort` | number | `3000` | Starting port for sequential auto-assignment when an agent omits `port` |
| `bind` | string | `"127.0.0.1"` | Bind address for all ACP TCP listeners. Use `"0.0.0.0"` to expose over the network. |
| `agents` | `Record<string, AcpBotConfig>` | required | Map of agent name → bot config. One TCP listener is created per entry. |

### `AcpBotConfig` fields (per agent)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `agent` | string | optional | Agent persona name (maps to an `AGENTS.md` file under `workingDirectory`). If omitted or unmatched, the bridge falls back to the default `AGENTS.md` at the working directory root. |
| `model` | string | optional | Default model id (e.g. `claude-sonnet-4.6`) for sessions on this agent |
| `workingDirectory` | string | **required at runtime** | Absolute path to the agent's workspace. Used as the default `cwd` for sessions and as the root for scanning custom agent definitions. |
| `admin` | boolean | optional | If true, the agent can manage other agents (admin tools available) |
| `token` | string | optional | Bearer token for remote/authenticated deployments |
| `port` | number | optional | Explicit TCP port. If omitted, the port is auto-assigned as `basePort + index` based on insertion order in `agents`. |

### Port assignment

If you omit `port` for some or all agents, ports are assigned by iterating
`Object.entries(agents)` in declaration order and using `basePort + index`.
Mixing explicit and auto-assigned ports works, but you must ensure no
collisions occur (e.g., if `basePort = 3000` and you explicitly set
`agents.foo.port = 3001`, the second auto-assigned agent would also pick
3001 unless declared first).

**Recommended:** assign explicit ports for all agents to avoid order-dependent
behavior.

---

## ACP wire protocol

- **Transport:** Raw TCP (custom transport per the
  [ACP spec's "custom transports" allowance](https://agentclientprotocol.com/protocol/transports#custom-transports)).
- **Framing:** Newline-delimited JSON (NDJSON), identical framing to ACP
  stdio mode. One JSON-RPC message per line.
- **URL format:** `tcp://<bind>:<port>` -- no path component (each agent has
  its own port, so paths would be redundant).
- **No TLS today** -- bind to `127.0.0.1` or terminate TLS at a reverse proxy.

### Connection lifecycle

1. Client opens TCP connection.
2. Client sends `initialize` JSON-RPC request.
3. Bridge responds with `agentCapabilities` (see below) and `protocolVersion`.
4. Client may call `session/new`, `session/resume`, etc.
5. Client may issue many `session/prompt` calls per session, and many sessions
   per connection.
6. Connection close triggers `closeAll` on the agent, aborting and
   disconnecting all sessions held by that connection.

### Advertised agent capabilities

The bridge advertises these capabilities in its `initialize` response:

```json
{
  "protocolVersion": 1,
  "agentCapabilities": {
    "sessionCapabilities": {
      "resume": {},
      "close": {}
    }
  }
}
```

- `sessionCapabilities.resume` -- supports `session/resume` (reconnect to an
  existing session without replaying history). The bridge looks up the
  session by ID in its in-memory map; if not found, it asks the SDK to
  resume.
- `sessionCapabilities.close` -- supports `session/close` (explicit session
  teardown).
- `loadSession` is **not** advertised; the bridge does not currently support
  full-history replay via `session/load`. Use `session/resume` instead.

---

## Persona, workspace, and cwd handling

The bridge handles workspace context **differently from raw `copilot --acp`
TCP mode**. Understanding the difference is important for client integrators.

### Raw `copilot --acp --port N` mode

- The persona is set by which directory the `copilot` binary was spawned in
  (it reads `AGENTS.md` from cwd at startup).
- The client **must** send `cwd` on every `session/new` to tell the agent
  where to do work.
- The persona and workspace are entangled with the OS-level spawn cwd.

### copilot-bridge ACP v2

- The persona is set per-session by passing `agent: <name>` to the SDK
  (`bridge.createSession({ agent: ..., workingDirectory: ..., ... })`).
- The workspace defaults from `botCfg.workingDirectory` configured in
  `platforms.acp.agents.<name>`. The client **may** send `cwd` on
  `session/new` to override, but it is **not required**.
- The bridge process itself can serve many personas without re-spawning.

In `copilot-agent.ts`:

```ts
const workingDirectory =
  typeof params.cwd === 'string' && params.cwd.length > 0
    ? params.cwd
    : this.botCfg.workingDirectory ?? process.cwd();
```

**Net effect for ACP clients:** under copilot-bridge, the client can be
entirely ignorant of where work is done. Connecting to `tcp://host:<port>`
is sufficient to drive that agent in its pre-configured workspace.

### Custom agent loading

`buildCustomAgents(workingDirectory)` scans the working directory for
additional agent definitions at session-create time. If the `agent` config
field names an agent definition that isn't found, the bridge logs a warning
and falls back to the default `AGENTS.md` at the workspace root.

---

## Permission handling (reverse calls)

The bridge implements a two-stage permission model when the Copilot SDK
fires a `PermissionRequest`:

1. **Local policy evaluation** -- `evaluateConfigPermissions(request,
   workingDirectory)` checks the config's `permissions.allow` and
   `permissions.deny` rules. If a rule matches:
   - `allow` → bridge auto-approves; client is never asked.
   - `deny` → bridge auto-rejects; client is never asked.
2. **Client reverse-call** -- if no policy rule applies, the bridge:
   - Sends a `session/update` notification with `sessionUpdate: 'tool_call'`
     status `pending`.
   - Calls back into the client via ACP `requestPermission` with two
     options: `allow` (kind `allow_once`) and `deny` (kind `reject_once`).
   - Translates the client's response into a Copilot SDK
     `PermissionRequestResult`:
     - `allow` selected → `{ kind: 'approve-once' }`
     - `deny` selected, or `cancelled` outcome → `{ kind: 'reject' }`

This means ACP clients only see permission prompts that the bridge's own
policy couldn't auto-decide. Clients **MUST** implement
`session/request_permission` per the ACP spec (it is a baseline client
method).

---

## Other ACP methods supported

| Method | Status | Notes |
|--------|--------|-------|
| `initialize` | required | Returns capabilities above |
| `authenticate` | implemented as no-op | Returns `{}`; bridge currently does not enforce ACP-level auth |
| `session/new` | full | Creates a session via `bridge.createSession(...)` |
| `session/prompt` | full | Sends a prompt and resolves on `session.idle` or `session.error` |
| `session/cancel` (notification) | full | Aborts the abort controller and calls `session.abort()` |
| `session/resume` | full | Capability-gated; reuses cached entry if present, else calls `bridge.resumeSession(...)` |
| `session/close` | full | Aborts, disconnects, releases, removes from map |
| `session/load` | **not implemented** | Capability not advertised |

### Streaming updates (agent → client)

The bridge subscribes to each session's `SessionEvent` stream and translates
events through `SdkEventTranslator` → `translateToSessionUpdate(...)` →
`connection.sessionUpdate({ sessionId, update })`:

| Bridge event | ACP `sessionUpdate` |
|--------------|---------------------|
| `streaming` (text chunk) | `agent_message_chunk` (content type `text`) |
| `tool_start` | `tool_call` (status `in_progress`, includes `rawInput`) |
| `tool_complete` (success) | `tool_call_update` (status `completed`, includes `rawOutput`) |
| `tool_complete` (failure) | `tool_call_update` (status `failed`, includes error string in `rawOutput`) |
| `completed` / `error` | (not forwarded; resolves the prompt request) |

---

## Migration from pre-v2

The pre-v2 ACP design (commits before `774659e`) exposed:

- A single WebSocket endpoint multiplexing all agents behind URL paths
  (e.g., `ws://host:3030/bob`, `ws://host:3030/homer`).
- An HTTP catalog endpoint at `GET /v1/agents/cards` advertising
  `acpWsUrl` and per-bot card metadata.
- Per-agent `.well-known/agent-card.json` endpoints.

All of the above have been removed. To migrate:

1. **Server side:** add a `platforms.acp` block with one `agents` entry per
   bot. Restart the bridge.
2. **Client side:** replace the single catalog-discovery + WS-multiplex
   provider with N independent ACP providers, one per agent port. Each is a
   vanilla raw-TCP ACP connection at `tcp://<bind>:<port>`.
3. **Discovery:** there is no replacement for the catalog endpoint today.
   Clients are expected to be configured with the explicit list of agent
   ports. If automatic discovery is needed, treat the bridge's `config.json`
   as the source of truth.

---

## Example client

See `acp-live-test.mjs` in the repo root for a minimal ACP client example.
Note that the version of this file in the repo still uses WebSocket and
predates the v2 redesign -- it should be treated as a starting point for
NDJSON framing rather than a working v2 example.

A correct v2 client connects via raw TCP and uses
`@agentclientprotocol/sdk`'s `ndJsonStream` helper:

```ts
import { connect } from 'node:net';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';

const socket = connect({ host: '127.0.0.1', port: 3030 });
await new Promise((resolve, reject) => {
  socket.once('connect', resolve);
  socket.once('error', reject);
});

const readable = Readable.toWeb(socket);
const writable = Writable.toWeb(socket);
const stream = ndJsonStream(writable, readable);

const client = {
  async requestPermission(params) {
    return { outcome: { outcome: 'selected', optionId: 'allow' } };
  },
  async sessionUpdate(params) {
    if (params.update.sessionUpdate === 'agent_message_chunk') {
      process.stdout.write(params.update.content.text);
    }
  },
};

const conn = new ClientSideConnection(() => client, stream);

await conn.initialize({
  protocolVersion: PROTOCOL_VERSION,
  clientCapabilities: {},
});

// cwd is optional; bridge fills in from botCfg.workingDirectory
const { sessionId } = await conn.newSession({ cwd: '', mcpServers: [] });

await conn.prompt({
  sessionId,
  prompt: [{ type: 'text', text: 'Hello!' }],
});
```

---

## Implementation reference

| File | Purpose |
|------|---------|
| `src/channels/acp-sdk/startup.ts` | Iterates `agents`, spawns one TCP listener per entry |
| `src/channels/acp-sdk/tcp-server.ts` | Per-agent TCP server; wires `AgentSideConnection` per connection |
| `src/channels/acp-sdk/copilot-agent.ts` | `CopilotAgent` class implementing the ACP `Agent` interface |
| `src/channels/acp-sdk/sdk-event-translator.ts` | Translates Copilot SDK events into simplified updates |
| `src/types.ts` | `AcpPlatformConfig`, `AcpBotConfig` type definitions |
