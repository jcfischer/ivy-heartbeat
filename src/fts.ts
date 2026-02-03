import type { Database } from 'bun:sqlite';

/**
 * Set up FTS5 full-text search on the events table.
 * Creates a content-sync virtual table indexing summary + metadata.
 * Idempotent — safe to call on every Blackboard init.
 */
export function setupFTS5(db: Database): void {
  // Create FTS5 virtual table (content-sync mode)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      summary,
      metadata,
      content=events,
      content_rowid=id
    );
  `);

  // Insert trigger: keep FTS in sync when events are added
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS events_fts_insert AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, summary, metadata)
      VALUES (new.id, new.summary, new.metadata);
    END;
  `);

  // Delete trigger: remove FTS entry when event is deleted
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS events_fts_delete AFTER DELETE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, summary, metadata)
      VALUES ('delete', old.id, old.summary, old.metadata);
    END;
  `);

  // Rebuild FTS index for any existing events not yet indexed
  // This handles the case where events existed before FTS was added
  rebuildFTSIndex(db);
}

/**
 * Rebuild the FTS5 index from the events table.
 * Safe to call at any time — rebuilds from scratch.
 */
export function rebuildFTSIndex(db: Database): void {
  db.exec(`INSERT INTO events_fts(events_fts) VALUES ('rebuild');`);
}
