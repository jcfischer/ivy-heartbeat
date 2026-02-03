import type { Database } from 'bun:sqlite';
import type { BlackboardEvent } from 'ivy-blackboard/src/types';

export interface ListOptions {
  limit?: number;
  since?: string; // ISO 8601 timestamp
}

/**
 * Read-only query repository for events.
 * Writing is handled by Blackboard.appendEvent() or ivy-blackboard's agent functions.
 */
export class EventQueryRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Get the N most recent events in reverse chronological order.
   */
  getRecent(limit: number): BlackboardEvent[] {
    return this.db
      .prepare('SELECT * FROM events ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as BlackboardEvent[];
  }

  /**
   * Get all events since a given ISO timestamp.
   */
  getSince(since: string): BlackboardEvent[] {
    return this.db
      .prepare(
        'SELECT * FROM events WHERE timestamp > ? ORDER BY timestamp ASC'
      )
      .all(since) as BlackboardEvent[];
  }

  /**
   * Get events filtered by type, with optional list options.
   */
  getByType(eventType: string, opts?: ListOptions): BlackboardEvent[] {
    const conditions: string[] = ['event_type = ?'];
    const params: unknown[] = [eventType];

    if (opts?.since) {
      conditions.push('timestamp > ?');
      params.push(opts.since);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limit = opts?.limit ? `LIMIT ${opts.limit}` : '';

    const sql = `SELECT * FROM events ${where} ORDER BY timestamp DESC ${limit}`;
    return this.db.prepare(sql).all(...params) as BlackboardEvent[];
  }

  /**
   * Get events filtered by actor, with optional list options.
   */
  getByActor(actorId: string, opts?: ListOptions): BlackboardEvent[] {
    const conditions: string[] = ['actor_id = ?'];
    const params: unknown[] = [actorId];

    if (opts?.since) {
      conditions.push('timestamp > ?');
      params.push(opts.since);
    }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const limit = opts?.limit ? `LIMIT ${opts.limit}` : '';

    const sql = `SELECT * FROM events ${where} ORDER BY timestamp DESC ${limit}`;
    return this.db.prepare(sql).all(...params) as BlackboardEvent[];
  }
}
