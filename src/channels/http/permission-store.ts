import { createLogger } from '../../logger.js';

const log = createLogger('permission-store');

export class PermissionStore {
  private approveAllSessions = new Map<string, boolean>();
  private toolApprovals = new Map<string, Set<string>>();
  private denyAllSessions = new Map<string, boolean>();
  private toolDenials = new Map<string, Set<string>>();

  shouldApprove(sessionId: string, toolKind: string): boolean {
    if (this.approveAllSessions.has(sessionId)) return true;
    return this.toolApprovals.get(sessionId)?.has(toolKind) ?? false;
  }

  shouldDeny(sessionId: string, toolKind: string): boolean {
    if (this.denyAllSessions.has(sessionId)) return true;
    return this.toolDenials.get(sessionId)?.has(toolKind) ?? false;
  }

  setApproveAll(sessionId: string): void {
    this.approveAllSessions.set(sessionId, true);
    log.debug('Approved all tools for session', { sessionId });
  }

  setApproveTool(sessionId: string, toolKind: string): void {
    let approvals = this.toolApprovals.get(sessionId);
    if (!approvals) {
      approvals = new Set<string>();
      this.toolApprovals.set(sessionId, approvals);
    }
    approvals.add(toolKind);
    log.debug('Approved tool for session', { sessionId, toolKind });
  }

  setDenyAll(sessionId: string): void {
    this.denyAllSessions.set(sessionId, true);
    log.debug('Denied all tools for session', { sessionId });
  }

  setDenyTool(sessionId: string, toolKind: string): void {
    let denials = this.toolDenials.get(sessionId);
    if (!denials) {
      denials = new Set<string>();
      this.toolDenials.set(sessionId, denials);
    }
    denials.add(toolKind);
    log.debug('Denied tool for session', { sessionId, toolKind });
  }

  clearSession(sessionId: string): void {
    const a1 = this.approveAllSessions.delete(sessionId);
    const a2 = this.toolApprovals.delete(sessionId);
    const d1 = this.denyAllSessions.delete(sessionId);
    const d2 = this.toolDenials.delete(sessionId);
    if (a1 || a2 || d1 || d2) {
      log.debug('Cleared permission state for session', { sessionId });
    }
  }
}
