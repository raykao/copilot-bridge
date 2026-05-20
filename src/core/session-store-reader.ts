import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';

function getDbPath(): string {
  const dir = process.env.COPILOT_HOME ?? path.join(os.homedir(), '.copilot');
  return path.join(dir, 'session-store.db');
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath(), { readonly: true });
  }
  return db;
}

export function getCurrentTurnIndex(sessionId: string): number {
  try {
    const row = getDb()
      .prepare('SELECT MAX(turn_index) AS max_idx FROM turns WHERE session_id = ?')
      .get(sessionId) as { max_idx: number | null } | undefined;
    return row?.max_idx ?? -1;
  } catch {
    return -1;
  }
}

export interface StoredTurn {
  turnIndex: number;
  userMessage: string | null;
  assistantResponse: string | null;
  timestamp: string;
}

export function getTurns(sessionId: string, since: number, limit: number): StoredTurn[] {
  try {
    const rows = getDb()
      .prepare(
        `SELECT turn_index, user_message, assistant_response, timestamp
         FROM turns
         WHERE session_id = ? AND turn_index >= ?
         ORDER BY turn_index ASC
         LIMIT ?`
      )
      .all(sessionId, since, limit) as Array<{
        turn_index: number;
        user_message: string | null;
        assistant_response: string | null;
        timestamp: string;
      }>;
    return rows.map((r) => ({
      turnIndex: r.turn_index,
      userMessage: r.user_message,
      assistantResponse: r.assistant_response,
      timestamp: r.timestamp,
    }));
  } catch {
    return [];
  }
}

export function sessionExistsInStore(sessionId: string): boolean {
  try {
    const row = getDb()
      .prepare('SELECT 1 FROM sessions WHERE id = ? LIMIT 1')
      .get(sessionId);
    return row !== undefined;
  } catch {
    return false;
  }
}
