import type { Database } from 'bun:sqlite';
import type { BlackboardHeartbeat } from 'ivy-blackboard/src/types';

/**
 * Read-only query repository for heartbeats.
 * Writing is handled by ivy-blackboard's sendHeartbeat().
 */
export class HeartbeatQueryRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Get the most recent heartbeat across all sessions.
   */
  getLatest(): BlackboardHeartbeat | null {
    const row = this.db
      .prepare('SELECT * FROM heartbeats ORDER BY timestamp DESC LIMIT 1')
      .get() as BlackboardHeartbeat | null;
    return row ?? null;
  }

  /**
   * Get the N most recent heartbeats.
   */
  getRecent(limit: number): BlackboardHeartbeat[] {
    return this.db
      .prepare('SELECT * FROM heartbeats ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as BlackboardHeartbeat[];
  }

  /**
   * Get all heartbeats since a given ISO timestamp.
   */
  getSince(since: string): BlackboardHeartbeat[] {
    return this.db
      .prepare(
        'SELECT * FROM heartbeats WHERE timestamp > ? ORDER BY timestamp ASC'
      )
      .all(since) as BlackboardHeartbeat[];
  }

  /**
   * Get all heartbeats for a specific agent session.
   */
  getBySession(sessionId: string): BlackboardHeartbeat[] {
    return this.db
      .prepare(
        'SELECT * FROM heartbeats WHERE session_id = ? ORDER BY timestamp DESC'
      )
      .all(sessionId) as BlackboardHeartbeat[];
  }
}
