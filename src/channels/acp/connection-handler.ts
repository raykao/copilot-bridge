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
import type {
  CopilotSession,
  PermissionRequest,
  PermissionRequestResult,
  SessionEvent,
} from '@github/copilot-sdk';
import { createLogger } from '../../logger.js';

const log = createLogger('acp-connection');

interface SessionEntry { session: CopilotSession; unsubscribe: () => void; }
interface PendingPermission { resolve: (result: PermissionRequestResult) => void; reject: (err: Error) => void; }

export class AcpConnectionHandler {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
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
      case 'session/close':
        await this.handleSessionClose(request);
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
    if (msg.result !== undefined) {
      pending.resolve(this.toPermissionResult(msg.result as SessionRequestPermissionResult));
    } else if (msg.error) {
      pending.reject(new Error(msg.error.message));
    }
  }

  private toPermissionResult(r: SessionRequestPermissionResult): PermissionRequestResult {
    if (r.decision === 'allow') {
      return { kind: 'approved' } as unknown as PermissionRequestResult;
    }
    return { kind: 'denied-by-rules', rules: [] } as unknown as PermissionRequestResult;
  }

  private handleInitialize(msg: JsonRpcRequest): void {
    const params = msg.params as InitializeParams;
    this.initialized = true;
    const result: InitializeResult = {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {},
      authMethods: [],
    };
    this.sendResponse(msg.id, result);
  }

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
      this.sendError(msg.id, -32603, `Failed to create session: ${errorMessage(err)}`);
      return;
    }

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
      } satisfies SessionRequestPermissionParams;

      this.send({
        jsonrpc: '2.0',
        id: requestId,
        method: 'session/request_permission',
        params,
      });

      return new Promise<PermissionRequestResult>((resolve, reject) => {
        this.pendingPermissions.set(requestId, { resolve, reject });
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
    this.sendResponse(msg.id, {});
  }

  async closeAll(): Promise<void> {
    for (const [, entry] of this.sessions) {
      entry.unsubscribe();
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
    }
    this.sessions.clear();

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
