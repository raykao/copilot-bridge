import { AgentSideConnection, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { Agent } from '@agentclientprotocol/sdk';
import type * as schema from '@agentclientprotocol/sdk';
import type { CopilotBridge } from '../../core/bridge.js';
import type { AcpBotConfig } from '../../types.js';
import { SdkEventTranslator } from './sdk-event-translator.js';
import type { SimplifiedUpdate } from './sdk-event-translator.js';
import { createLogger } from '../../logger.js';
import { buildCustomAgents } from '../../core/session-manager.js';
import { evaluateConfigPermissions } from '../../config.js';
import type { CopilotSession, PermissionRequest, PermissionRequestResult, SessionEvent } from '@github/copilot-sdk';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const log = createLogger('acp-sdk-agent');

interface SessionEntry {
  session: CopilotSession;
  unsubscribe: () => void;
  translator: SdkEventTranslator;
  abortController: AbortController;
}

// @internal exported for tests
export function translateToSessionUpdate(
  update: SimplifiedUpdate,
  _sessionId: string,
): schema.SessionUpdate | null {
  switch (update.type) {
    case 'streaming':
      return {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: update.content },
      };
    case 'tool_start':
      return {
        sessionUpdate: 'tool_call',
        toolCallId: update.toolCallId,
        title: update.toolName,
        kind: 'other',
        status: 'in_progress',
      };
    case 'tool_complete':
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: update.toolCallId,
        status: update.success ? 'completed' : 'failed',
      };
    case 'completed':
    case 'error':
      return null;
    default:
      return null;
  }
}

export class CopilotAgent implements Agent {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly connection: AgentSideConnection,
    private readonly botCfg: AcpBotConfig,
    private readonly bridge: CopilotBridge,
  ) {}

  async initialize(_params: schema.InitializeRequest): Promise<schema.InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        sessionCapabilities: {
          resume: {},
          close: {},
        },
      },
    };
  }

  async newSession(params: schema.NewSessionRequest): Promise<schema.NewSessionResponse> {
    const workingDirectory = typeof params.cwd === 'string' && params.cwd.length > 0
      ? params.cwd
      : this.botCfg.workingDirectory ?? process.cwd();
    const model = this.botCfg.model;
    let agentName: string | undefined = this.botCfg.agent;
    const customAgents = buildCustomAgents(workingDirectory);

    if (agentName) {
      if (!customAgents.some(a => a.name === agentName)) {
        log.warn(`agent_missing_definition agent=${agentName} workingDirectory=${workingDirectory}`);
        agentName = undefined;
      }
    }

    let session: CopilotSession;
    try {
      session = await this.bridge.createSession({
        workingDirectory,
        agent: agentName,
        model,
        customAgents,
        // mcpServers from ACP SDK is Array<McpServer> but bridge expects Record<string, MCPServerConfig>.
        // The bridge manages MCP servers centrally via config, so we don't pass them per-session.
        onPermissionRequest: this.makePermissionHandler(),
      });
    } catch (err) {
      log.warn(`session_open_failed agent=${agentName ?? 'AGENTS.md'} error=${errorMessage(err)}`);
      throw new Error(`Failed to create session: ${errorMessage(err)}`);
    }

    const entry = this.createSessionEntry(session);
    this.sessions.set(session.sessionId, entry);
    log.info(`session_open acpSessionId=${session.sessionId} agent=${agentName ?? 'AGENTS.md'} model=${model ?? 'default'}`);
    return { sessionId: session.sessionId };
  }

  async prompt(params: schema.PromptRequest): Promise<schema.PromptResponse> {
    const entry = this.sessions.get(params.sessionId);
    if (!entry) {
      throw new Error('Session not found: ' + params.sessionId);
    }

    if (entry.abortController.signal.aborted) {
      return { stopReason: 'cancelled' };
    }

    const text = params.prompt
      .flatMap((b): string[] => {
        if (b.type === 'text') {
          return [(b as schema.TextContent).text];
        }
        if (b.type === 'resource_link') {
          const r = b as schema.ResourceLink;
          const label = r.title ?? r.name;
          if (r.uri.startsWith('file://')) {
            const fsPath = r.uri.slice('file://'.length);
            try {
              const content = readFileSync(fsPath, 'utf-8');
              return [`[File: ${label} (${r.uri})]\n${content}`];
            } catch {
              return [`[File reference: ${label} (${r.uri}) — could not read]`];
            }
          }
          return [`[Resource: ${label} (${r.uri})]`];
        }
        return [];
      })
      .join('\n');

    let unsubscribeIdle = (): void => {};
    const idlePromise = new Promise<schema.PromptResponse>((resolve) => {
      unsubscribeIdle = entry.session.on((event: SessionEvent) => {
        if (event.type === 'session.idle' || event.type === 'session.error') {
          unsubscribeIdle();
          resolve({
            stopReason: entry.abortController.signal.aborted ? 'cancelled' : 'end_turn',
          });
        }
      });
    });

    try {
      await entry.session.send({ prompt: text });
    } catch (err) {
      unsubscribeIdle();
      throw new Error(`send failed: ${errorMessage(err)}`);
    }

    return idlePromise;
  }

  async cancel(params: schema.CancelNotification): Promise<void> {
    const entry = this.sessions.get(params.sessionId);
    if (!entry) return;
    entry.abortController.abort();
    try {
      await entry.session.abort();
    } catch {
      // best-effort
    }
  }

  async authenticate(_params: schema.AuthenticateRequest): Promise<schema.AuthenticateResponse> {
    return {};
  }

  async resumeSession(params: schema.ResumeSessionRequest): Promise<schema.ResumeSessionResponse> {
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      log.info(`session_resume_cached acpSessionId=${params.sessionId}`);
      return { sessionId: params.sessionId } as schema.ResumeSessionResponse;
    }

    const workingDirectory = typeof params.cwd === 'string' && params.cwd.length > 0
      ? params.cwd
      : this.botCfg.workingDirectory ?? process.cwd();
    let agentName: string | undefined = this.botCfg.agent;
    const customAgents = buildCustomAgents(workingDirectory);
    if (agentName) {
      if (!customAgents.some(a => a.name === agentName)) {
        log.warn(`agent_missing_definition agent=${agentName} workingDirectory=${workingDirectory}`);
        agentName = undefined;
      }
    }

    let session: CopilotSession;
    try {
      session = await this.bridge.resumeSession(params.sessionId, {
        workingDirectory,
        agent: agentName,
        customAgents,
        // mcpServers from ACP SDK is Array<McpServer> but bridge expects Record<string, MCPServerConfig>.
        // The bridge manages MCP servers centrally via config, so we don't pass them per-session.
        onPermissionRequest: this.makePermissionHandler(),
      });
    } catch (err) {
      log.warn(`session_resume_failed acpSessionId=${params.sessionId} error=${errorMessage(err)}`);
      throw new Error(`Failed to resume session: ${errorMessage(err)}`);
    }

    const entry = this.createSessionEntry(session);
    this.sessions.set(session.sessionId, entry);
    log.info(`session_resume acpSessionId=${session.sessionId} agent=${agentName ?? 'AGENTS.md'}`);
    return { sessionId: params.sessionId } as schema.ResumeSessionResponse;
  }

  async closeSession(params: schema.CloseSessionRequest): Promise<schema.CloseSessionResponse> {
    const entry = this.sessions.get(params.sessionId);
    if (!entry) {
      return {};
    }

    entry.unsubscribe();
    entry.abortController.abort();
    this.sessions.delete(params.sessionId);
    try {
      await entry.session.abort();
    } catch {
      // best-effort
    }
    try {
      await entry.session.disconnect();
    } catch {
      // best-effort
    }
    this.bridge.releaseSession(params.sessionId);
    log.info(`session_close acpSessionId=${params.sessionId}`);
    return {};
  }

  async closeAll(): Promise<void> {
    log.info(`close_all sessions=${this.sessions.size}`);
    for (const [sessionId, entry] of this.sessions) {
      entry.unsubscribe();
      try {
        await entry.session.disconnect();
      } catch {
        // best-effort
      }
      this.bridge.releaseSession(sessionId);
    }
    this.sessions.clear();
  }

  private createSessionEntry(session: CopilotSession): SessionEntry {
    const translator = new SdkEventTranslator();
    const unsubscribe = session.on(async (event: SessionEvent) => {
      const translated = translator.translate(event);
      if (translated) {
        log.debug(`session_update acpSessionId=${session.sessionId} kind=${translated.type}`);
        const update = translateToSessionUpdate(translated, session.sessionId);
        if (update) {
          await this.connection.sessionUpdate({ sessionId: session.sessionId, update });
        }
      }
      const eventType: string = event.type;
      void eventType;
    });
    return { session, unsubscribe, translator, abortController: new AbortController() };
  }

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
      const toolCallId = request.toolCallId ?? requestId;
      try {
        await this.connection.sessionUpdate({
          sessionId: invocation.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId,
            title: request.kind,
            kind: 'other',
            status: 'pending',
          },
        });
      } catch {
        // best-effort: proceed to requestPermission even if notification fails
      }
      const result = await this.connection.requestPermission({
        sessionId: invocation.sessionId,
        toolCall: {
          toolCallId,
          title: request.kind,
          kind: 'other',
          status: 'pending',
        },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      });

      if (result.outcome.outcome === 'cancelled') {
        return { kind: 'reject' };
      }

      if (result.outcome.outcome === 'selected' && result.outcome.optionId === 'allow') {
        return { kind: 'approve-once' };
      }

      return { kind: 'reject' };
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
