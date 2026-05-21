import type { SessionStatus, PendingPermission, SessionState } from '../../core/session-types.js';
export type { SessionStatus, PendingPermission, SessionState };
import type { SessionEvent } from '@github/copilot-sdk';

// JSON-RPC 2.0 base types

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  id: string | number;
  params?: unknown;
  traceparent?: string;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  // no id field
  params?: unknown;
  traceparent?: string;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  traceparent?: string;
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
  // Full SDK PermissionRequest object, forwarded as-is so the client can render
  // kind-specific details. Kept loosely typed here because the SDK schema is
  // versioned upstream and the bridge intentionally pass-throughs.
  request?: unknown;
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

// session/transcript

export interface Turn {
  turnIndex: number;
  userMessage: string | null;
  assistantResponse: string | null;
  timestamp: string;
}

export interface SessionTranscriptParams {
  sessionId: string;
  since?: number;
  limit?: number;
}

export interface SessionTranscriptResult {
  sessionId: string;
  turns: Turn[];
  hasMore: boolean;
}
