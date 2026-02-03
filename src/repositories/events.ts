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
export interface SearchResult {
  event: BlackboardEvent;
  rank: number;
}

export class EventQueryRepository {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Full-text search across events summary and metadata using FTS5.
   * Returns matching events ranked by relevance (lower rank = better match).
   */
  search(query: string, opts?: ListOptions): SearchResult[] {
    const limit = opts?.limit ? `LIMIT ${opts.limit}` : 'LIMIT 50';
    const sinceClause = opts?.since ? `AND e.timestamp > '${opts.since}'` : '';

    const sql = `
      SELECT e.*, fts.rank
      FROM events_fts fts
      JOIN events e ON e.id = fts.rowid
      WHERE events_fts MATCH ?
      ${sinceClause}
      ORDER BY fts.rank
      ${limit}
    `;

    const rows = this.db.prepare(sql).all(query) as (BlackboardEvent & { rank: number })[];
    return rows.map((row) => ({
      event: {
        id: row.id,
        timestamp: row.timestamp,
        event_type: row.event_type,
        actor_id: row.actor_id,
        target_id: row.target_id,
        target_type: row.target_type,
        summary: row.summary,
        metadata: row.metadata,
      } as BlackboardEvent,
      rank: row.rank,
    }));
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
