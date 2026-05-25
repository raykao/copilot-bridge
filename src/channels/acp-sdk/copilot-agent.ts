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

    if (agentName) {
      const customAgents = buildCustomAgents(workingDirectory);
      if (!customAgents.some(a => a.name === agentName)) {
        log.warn(`agent_missing_definition agent=${agentName} workingDirectory=${workingDirectory}`);
        agentName = undefined;
      }
    }

    let session: CopilotSession;
    try {
      session = await this.bridge.getOrCreateBotSession(workingDirectory, agentName, {
        model,
        onPermissionRequest: this.makePermissionHandler(),
      });
    } catch (err) {
      log.warn(`session_open_failed agent=${agentName ?? 'AGENTS.md'} error=${errorMessage(err)}`);
      throw new Error(`Failed to create session: ${errorMessage(err)}`);
    }

    const entry = this.createSessionEntry(session);
    this.sessions.set(session.sessionId, entry);

    log.info(`session_open acpSessionId=${session.sessionId} agent=${agentName ?? 'AGENTS.md'} model=${model ?? 'default'}`);
    this.bridge.setSessionStatus(session.sessionId, 'idle');
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
      .filter(b => b.type === 'text')
      .map(b => (b as schema.TextContent).text)
      .join('\n');

    let unsubscribeIdle = (): void => {};
    const idlePromise = new Promise<schema.PromptResponse>((resolve) => {
      unsubscribeIdle = entry.session.on((event: SessionEvent) => {
        if (event.type === 'session.idle') {
          unsubscribeIdle();
          resolve({ stopReason: 'end_turn' });
        } else if (event.type === 'session.error') {
          unsubscribeIdle();
          resolve({ stopReason: 'end_turn' });
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

    const workingDirectory = this.botCfg.workingDirectory ?? process.cwd();
    let agentName: string | undefined = this.botCfg.agent;
    if (agentName) {
      const customAgents = buildCustomAgents(workingDirectory);
      if (!customAgents.some(a => a.name === agentName)) {
        log.warn(`agent_missing_definition agent=${agentName} workingDirectory=${workingDirectory}`);
        agentName = undefined;
      }
    }

    let session: CopilotSession;
    try {
      session = await this.bridge.forceResumeSession(params.sessionId, {
        workingDirectory,
        agent: agentName,
        onPermissionRequest: this.makePermissionHandler(),
      });
    } catch (err) {
      log.warn(`session_resume_failed acpSessionId=${params.sessionId} error=${errorMessage(err)}`);
      throw new Error(`Failed to resume session: ${errorMessage(err)}`);
    }

    const entry = this.createSessionEntry(session);
    this.sessions.set(session.sessionId, entry);

    log.info(`session_resume acpSessionId=${session.sessionId} agent=${agentName ?? 'AGENTS.md'}`);
    this.bridge.setSessionStatus(session.sessionId, 'idle');
    return { sessionId: params.sessionId } as schema.ResumeSessionResponse;
  }

  async closeSession(params: schema.CloseSessionRequest): Promise<schema.CloseSessionResponse> {
    const entry = this.sessions.get(params.sessionId);
    if (!entry) {
      return {};
    }

    entry.unsubscribe();
    this.sessions.delete(params.sessionId);
    try {
      await entry.session.disconnect();
    } catch {
      // best-effort
    }
    log.info(`session_close acpSessionId=${params.sessionId}`);
    return {};
  }

  async closeAll(): Promise<void> {
    log.info(`close_all sessions=${this.sessions.size}`);
    for (const [, entry] of this.sessions) {
      entry.unsubscribe();
      try {
        await entry.session.disconnect();
      } catch {
        // best-effort
      }
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
      if (eventType === 'session.in_progress') {
        this.bridge.setSessionStatus(session.sessionId, 'in_progress');
      } else if (eventType === 'session.idle' || eventType === 'agent_idle') {
        this.bridge.setSessionStatus(session.sessionId, 'idle');
      } else if (eventType === 'session.error') {
        this.bridge.setSessionStatus(session.sessionId, 'error');
      }
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
      this.bridge.addPendingPermission(invocation.sessionId, {
        requestId,
        kind: request.kind,
        ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        requestedAt: new Date().toISOString(),
      });

      try {
        const result = await this.connection.requestPermission({
          sessionId: invocation.sessionId,
          toolCall: {
            toolCallId: request.toolCallId ?? requestId,
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
      } finally {
        this.bridge.removePendingPermission(invocation.sessionId, requestId);
      }
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
