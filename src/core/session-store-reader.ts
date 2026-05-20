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
