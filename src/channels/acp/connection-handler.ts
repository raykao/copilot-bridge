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
} from './types.js';
import type {
  SessionGetParams,
  SessionGetResult,
  SessionListResult,
  SessionSubscribeParams,
  SessionSubscribeResult,
  SessionUnsubscribeParams,
  SessionTranscriptParams,
  SessionTranscriptResult,
  Turn,
} from './types.js';
import type { SessionState } from '../../core/session-types.js';
import { translateSdkEvent } from './sdk-event-translator.js';
import type {
  CopilotSession,
  PermissionRequest,
  PermissionRequestResult,
  SessionEvent,
} from '@github/copilot-sdk';
import { createLogger } from '../../logger.js';
import { buildCustomAgents } from '../../core/session-manager.js';
import { evaluateConfigPermissions } from '../../config.js';

const log = createLogger('acp-connection');

interface SessionEntry { session: CopilotSession; unsubscribe: () => void; }
interface PendingPermission { resolve: (result: PermissionRequestResult) => void; reject: (err: Error) => void; sessionId: string; }

export class AcpConnectionHandler {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly subscriptions = new Map<string, () => void>();
  private initialized = false;

  constructor(
    private readonly botCfg: AcpBotConfig,
    private readonly bridge: CopilotBridge,
    private readonly send: (msg: object) => void,
  ) {}

  private sendResponse(id: string | number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  private sendError(id: string | number | null, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async handle(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendError(null, -32700, 'Parse error');
      return;
    }

    if (!isRecord(parsed)) {
      this.sendError(null, -32600, 'Invalid Request');
      return;
    }

    if (typeof parsed.method === 'string') {
      await this.handleRequest(parsed as unknown as AcpIncoming);
      return;
    }

    if ('result' in parsed || 'error' in parsed) {
      this.handlePermissionResponse(parsed as unknown as JsonRpcResponse);
      return;
    }

    this.sendError(null, -32600, 'Invalid Request');
  }

  private async handleRequest(msg: AcpIncoming): Promise<void> {
    const request = msg as JsonRpcRequest;
    switch (request.method) {
      case 'initialize':
        this.handleInitialize(request);
        break;
      case 'session/new':
        await this.handleSessionNew(request);
        break;
      case 'session/prompt':
        await this.handleSessionPrompt(request);
        break;
      case 'session/cancel':
        await this.handleSessionCancel(request);
        break;
      case 'session/resume':
        await this.handleSessionResume(request);
        break;
      case 'session/close':
        await this.handleSessionClose(request);
        break;
      case 'session/get':
        await this.handleSessionGet(request);
        break;
      case 'session/list':
        await this.handleSessionList(request);
        break;
      case 'session/subscribe':
        this.handleSessionSubscribe(request);
        break;
      case 'session/unsubscribe':
        this.handleSessionUnsubscribe(request);
        break;
      case 'session/transcript':
        await this.handleSessionTranscript(request);
        break;
      default:
        this.sendError(request.id, -32601, 'Method not found');
        break;
    }
  }

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

  private toPermissionResult(r: SessionRequestPermissionResult): PermissionRequestResult {
    if (r.decision === 'allow') {
      return { kind: 'approve-once' };
    }
    return { kind: 'reject' };
  }

  private handleInitialize(msg: JsonRpcRequest): void {
    const params = msg.params as InitializeParams;
    this.initialized = true;
    const result: InitializeResult = {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {},
      authMethods: [],
      serverCapabilities: { session: { resume: true } },
    };
    this.sendResponse(msg.id, result);
  }

  private async handleSessionNew(msg: JsonRpcRequest): Promise<void> {
    const params = (msg.params ?? {}) as SessionNewParams;
    const workingDirectory = this.botCfg.workingDirectory ?? process.cwd();
    const model = params.model ?? this.botCfg.model;
    let agentName: string | undefined = this.botCfg.agent;

    if (agentName) {
      const customAgents = buildCustomAgents(workingDirectory);
      if (!customAgents.some(a => a.name === agentName)) {
        log.warn(`Agent "${agentName}" has no definition in ${workingDirectory}, falling back to AGENTS.md`);
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
      this.sendError(msg.id, -32603, `Failed to create session: ${errorMessage(err)}`);
      return;
    }

    const unsubscribe = session.on((event: SessionEvent) => {
      const translated = translateSdkEvent(event);
      if (translated) {
        log.debug(`session_update acpSessionId=${session.sessionId} kind=${(translated as { type?: string })?.type ?? 'unknown'}`);
        this.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: session.sessionId, ...translated },
        });
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
    this.sessions.set(session.sessionId, { session, unsubscribe });

    const result: SessionNewResult = { sessionId: session.sessionId };
    log.info(`session_open acpSessionId=${session.sessionId} agent=${agentName ?? 'AGENTS.md'} model=${model ?? 'default'}`);
    this.sendResponse(msg.id, result);
    this.bridge.setSessionStatus(session.sessionId, 'idle');
  }

  private async handleSessionResume(msg: JsonRpcRequest): Promise<void> {
    const params = (msg.params ?? {}) as { sessionId: string };
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      log.info(`session_resume_cached acpSessionId=${params.sessionId}`);
      this.sendResponse(msg.id, { sessionId: params.sessionId });
      return;
    }

    const workingDirectory = this.botCfg.workingDirectory ?? process.cwd();
    let agentName: string | undefined = this.botCfg.agent;
    if (agentName) {
      const customAgents = buildCustomAgents(workingDirectory);
      if (!customAgents.some(a => a.name === agentName)) {
        log.warn(`Agent "${agentName}" has no definition in ${workingDirectory}, falling back to AGENTS.md`);
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
      this.sendError(msg.id, -32002, `Failed to resume session: ${errorMessage(err)}`);
      return;
    }

    const unsubscribe = session.on((event: SessionEvent) => {
      const translated = translateSdkEvent(event);
      if (translated) {
        log.debug(`session_update acpSessionId=${session.sessionId} kind=${(translated as { type?: string })?.type ?? 'unknown'}`);
        this.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: { sessionId: session.sessionId, ...translated },
        });
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
    this.sessions.set(session.sessionId, { session, unsubscribe });

    log.info(`session_resume acpSessionId=${session.sessionId} agent=${agentName ?? 'AGENTS.md'}`);
    this.sendResponse(msg.id, { sessionId: session.sessionId });
    this.bridge.setSessionStatus(session.sessionId, 'idle');
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

  private async handleSessionPrompt(msg: JsonRpcRequest): Promise<void> {
    const params = msg.params as SessionPromptParams;
    const entry = this.sessions.get(params.sessionId);
    if (!entry) {
      this.sendError(msg.id, -32603, 'Session not found');
      return;
    }

    let stopReason: SessionPromptResult['stopReason'] = 'idle';
    let unsubscribeIdle = (): void => {};
    const idlePromise = new Promise<void>((resolve) => {
      unsubscribeIdle = entry.session.on((event: SessionEvent) => {
        if (event.type === 'session.idle') {
          unsubscribeIdle();
          resolve();
        } else if (event.type === 'session.error') {
          stopReason = 'error';
          unsubscribeIdle();
          resolve();
        }
      });
    });

    try {
      await entry.session.send({ prompt: params.prompt });
    } catch (err) {
      unsubscribeIdle();
      this.sendError(msg.id, -32603, `send failed: ${errorMessage(err)}`);
      return;
    }

    await idlePromise;
    const result: SessionPromptResult = { stopReason };
    this.sendResponse(msg.id, result);
  }

  private async handleSessionCancel(msg: JsonRpcRequest): Promise<void> {
    const params = msg.params as SessionCancelParams;
    const entry = this.sessions.get(params.sessionId);
    if (!entry) {
      this.sendError(msg.id, -32603, 'Session not found');
      return;
    }

    try {
      await entry.session.abort();
    } catch {
      // best-effort
    }
    this.sendResponse(msg.id, {});
  }

  private async handleSessionClose(msg: JsonRpcRequest): Promise<void> {
    const params = msg.params as SessionCloseParams;
    const entry = this.sessions.get(params.sessionId);
    if (!entry) {
      this.sendError(msg.id, -32603, 'Session not found');
      return;
    }

    entry.unsubscribe();
    this.sessions.delete(params.sessionId);
    try {
      await entry.session.disconnect();
    } catch {
      // best-effort
    }
    log.info(`session_close acpSessionId=${params.sessionId}`);
    this.sendResponse(msg.id, {});
  }


  private async handleSessionGet(msg: JsonRpcRequest): Promise<void> {
    const params = (msg.params ?? {}) as SessionGetParams;
    if (!params.sessionId) {
      this.sendError(msg.id, -32600, 'Missing required field: sessionId');
      return;
    }
    const state = this.bridge.getSessionState(params.sessionId);
    if (!state) {
      this.sendError(msg.id, -32001, `Session not found: ${params.sessionId}`);
      return;
    }
    const result: SessionGetResult = state;
    this.sendResponse(msg.id, result);
  }

  private async handleSessionList(msg: JsonRpcRequest): Promise<void> {
    const states = await this.bridge.getAllSessionStates();
    const result: SessionListResult = { sessions: states };
    this.sendResponse(msg.id, result);
  }

  private handleSessionSubscribe(msg: JsonRpcRequest): void {
    const params = (msg.params ?? {}) as SessionSubscribeParams;
    if (!params.sessionId) {
      this.sendError(msg.id, -32600, 'Missing required field: sessionId');
      return;
    }
    const state = this.bridge.getSessionState(params.sessionId);
    if (!state) {
      this.sendError(msg.id, -32001, `Session not found: ${params.sessionId}`);
      return;
    }
    // Idempotent: cancel existing subscription if any
    const existing = this.subscriptions.get(params.sessionId);
    if (existing) existing();

    const cb = (newState: SessionState): void => {
      this.send({ jsonrpc: '2.0', method: 'session/state_changed', params: newState });
    };
    this.bridge.subscribeToSession(params.sessionId, cb);
    this.subscriptions.set(params.sessionId, () => this.bridge.unsubscribeFromSession(params.sessionId, cb));

    const result: SessionSubscribeResult = { subscribed: true, sessionId: params.sessionId };
    this.sendResponse(msg.id, result);
  }

  private handleSessionUnsubscribe(msg: JsonRpcRequest): void {
    const params = (msg.params ?? {}) as SessionUnsubscribeParams;
    if (!params.sessionId) {
      this.sendError(msg.id, -32600, 'Missing required field: sessionId');
      return;
    }
    const unsub = this.subscriptions.get(params.sessionId);
    if (unsub) {
      unsub();
      this.subscriptions.delete(params.sessionId);
    }
    this.sendResponse(msg.id, {});
  }

  private async handleSessionTranscript(msg: JsonRpcRequest): Promise<void> {
    const params = (msg.params ?? {}) as SessionTranscriptParams;
    if (!params.sessionId) {
      this.sendError(msg.id, -32600, 'Missing required field: sessionId');
      return;
    }
    const since = params.since ?? 0;
    const limit = params.limit ?? 200;
    if (since < 0) {
      this.sendError(msg.id, -32600, 'since must be >= 0');
      return;
    }
    if (limit > 500) {
      this.sendError(msg.id, -32600, 'limit must be <= 500');
      return;
    }
    const { turns: storedTurns, hasMore, sessionFound } =
      this.bridge.getSessionTranscript(params.sessionId, since, limit);
    if (!sessionFound) {
      this.sendError(msg.id, -32001, `Session not found: ${params.sessionId}`);
      return;
    }
    const turns: Turn[] = storedTurns.map((t) => ({
      turnIndex: t.turnIndex,
      userMessage: t.userMessage,
      assistantResponse: t.assistantResponse,
      timestamp: t.timestamp,
    }));
    const result: SessionTranscriptResult = { sessionId: params.sessionId, turns, hasMore };
    this.sendResponse(msg.id, result);
  }

  async closeAll(): Promise<void> {
    log.info(`close_all sessions=${this.sessions.size} pendingPermissions=${this.pendingPermissions.size}`);
    for (const [, entry] of this.sessions) {
      entry.unsubscribe();
    }
    this.sessions.clear();

    for (const [, unsub] of this.subscriptions) {
      unsub();
    }
    this.subscriptions.clear();

    for (const [, pending] of this.pendingPermissions) {
      pending.reject(new Error('Connection closed'));
    }
    this.pendingPermissions.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
