// Maps between A2A concepts and copilot-bridge sessions.
// contextId (A2A) -> copilot sessionId
// taskId (A2A)    -> copilot sessionId

export class SessionMap {
  private contextToSession = new Map<string, string>(); // contextId -> sessionId
  private taskToSession   = new Map<string, string>(); // taskId    -> sessionId
  private taskToContext   = new Map<string, string>(); // taskId    -> contextId

  link(taskId: string, contextId: string, sessionId: string): void {
    this.taskToSession.set(taskId, sessionId);
    this.taskToContext.set(taskId, contextId);
    this.contextToSession.set(contextId, sessionId);
  }

  getSessionForTask(taskId: string): string | undefined {
    return this.taskToSession.get(taskId);
  }

  getSessionForContext(contextId: string): string | undefined {
    return this.contextToSession.get(contextId);
  }

  getContextForTask(taskId: string): string | undefined {
    return this.taskToContext.get(taskId);
  }

  unlink(taskId: string): void {
    const contextId = this.taskToContext.get(taskId);
    if (contextId !== undefined) {
      this.contextToSession.delete(contextId);
    }
    this.taskToSession.delete(taskId);
    this.taskToContext.delete(taskId);
  }
}
