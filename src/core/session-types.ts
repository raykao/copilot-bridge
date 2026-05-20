export type SessionStatus = 'idle' | 'in_progress' | 'error' | 'unknown';

export interface PendingPermission {
  requestId: string;
  kind: string;
  toolCallId?: string;
  requestedAt: string;
}

export interface SessionState {
  id: string;
  agent: string | null;
  status: SessionStatus;
  currentTurnIndex: number;
  pendingPermissions: PendingPermission[];
  updatedAt: string;
}
