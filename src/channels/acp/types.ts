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
  serverCapabilities?: { session?: { resume?: boolean } };
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
