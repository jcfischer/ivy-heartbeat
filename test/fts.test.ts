import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Blackboard } from '../src/blackboard.ts';

describe('FTS5 full-text search', () => {
  let bb: Blackboard;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hb-fts-'));
    const dbPath = join(tmpDir, 'test.db');
    bb = new Blackboard(dbPath);
  });

  afterEach(() => {
    bb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('events_fts table exists after init', () => {
    const tables = bb.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events_fts'")
      .all() as { name: string }[];
    expect(tables.length).toBe(1);
  });

  test('insert trigger exists', () => {
    const triggers = bb.db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='events_fts_insert'")
      .all() as { name: string }[];
    expect(triggers.length).toBe(1);
  });

  test('delete trigger exists', () => {
    const triggers = bb.db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='events_fts_delete'")
      .all() as { name: string }[];
    expect(triggers.length).toBe(1);
  });

  test('search returns empty for no matches', () => {
    const results = bb.eventQueries.search('nonexistent_query_xyz');
    expect(results).toHaveLength(0);
  });

  test('search finds events by summary text', () => {
    const agent = bb.registerAgent({ name: 'test' });

    bb.appendEvent({
      actorId: agent.session_id,
      summary: 'Calendar conflict detected for meeting tomorrow',
      metadata: { checkName: 'Calendar' },
    });

    bb.appendEvent({
      actorId: agent.session_id,
      summary: 'Email backlog at 5 unread messages',
      metadata: { checkName: 'Email' },
    });

    const results = bb.eventQueries.search('calendar conflict');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].event.summary).toContain('Calendar conflict');
  });

  test('search finds events by metadata content', () => {
    const agent = bb.registerAgent({ name: 'test' });

    bb.appendEvent({
      actorId: agent.session_id,
      summary: 'Check passed',
      metadata: { checkName: 'SpecialMetadataToken' },
    });

    const results = bb.eventQueries.search('SpecialMetadataToken');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test('search respects limit option', () => {
    const agent = bb.registerAgent({ name: 'test' });

    for (let i = 0; i < 10; i++) {
      bb.appendEvent({
        actorId: agent.session_id,
        summary: `Heartbeat check iteration ${i}`,
      });
    }

    const results = bb.eventQueries.search('Heartbeat', { limit: 3 });
    expect(results.length).toBe(3);
  });

  test('search results include rank score', () => {
    const agent = bb.registerAgent({ name: 'test' });

    bb.appendEvent({
      actorId: agent.session_id,
      summary: 'Alert dispatched for calendar conflict',
    });

    const results = bb.eventQueries.search('alert');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(typeof results[0].rank).toBe('number');
  });

  test('search is case-insensitive', () => {
    const agent = bb.registerAgent({ name: 'test' });

    bb.appendEvent({
      actorId: agent.session_id,
      summary: 'CRITICAL ALERT for system health',
    });

    const results = bb.eventQueries.search('critical alert');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test('multiple Blackboard inits do not duplicate FTS table', () => {
    // Close and re-open same DB — should not error
    const dbPath = join(tmpDir, 'test.db');
    bb.close();
    bb = new Blackboard(dbPath);

    const tables = bb.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='events_fts'")
      .all() as { name: string }[];
    expect(tables.length).toBe(1);
  });

  test('search performance: <100ms for 1000 events', () => {
    const agent = bb.registerAgent({ name: 'test' });

    // Insert 1000 events
    const stmt = bb.db.prepare(
      `INSERT INTO events (timestamp, event_type, actor_id, target_type, summary, metadata)
       VALUES (?, 'heartbeat_received', ?, 'agent', ?, ?)`
    );

    const now = Date.now();
    for (let i = 0; i < 1000; i++) {
      stmt.run(
        new Date(now - i * 60000).toISOString(),
        agent.session_id,
        `Heartbeat check ${i}: system health is ${i % 2 === 0 ? 'good' : 'degraded'}`,
        JSON.stringify({ iteration: i, status: i % 2 === 0 ? 'ok' : 'alert' })
      );
    }

    const start = performance.now();
    const results = bb.eventQueries.search('degraded');
    const elapsed = performance.now() - start;

    expect(results.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });
});
