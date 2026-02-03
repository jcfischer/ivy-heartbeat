import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTestContext, cleanupTestContext, type TestContext } from './helpers.ts';
import { Blackboard } from '../src/blackboard.ts';

let ctx: TestContext;

describe('Blackboard initialization (via ivy-blackboard)', () => {
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => { cleanupTestContext(ctx); });

  test('creates all required tables', () => {
    const tables = ctx.bb.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name).sort();
    expect(names).toContain('agents');
    expect(names).toContain('projects');
    expect(names).toContain('work_items');
    expect(names).toContain('heartbeats');
    expect(names).toContain('events');
    expect(names).toContain('schema_version');
  });

  test('enables WAL journal mode', () => {
    const result = ctx.bb.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(result.journal_mode).toBe('wal');
  });

  test('enables foreign keys', () => {
    const result = ctx.bb.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(result.foreign_keys).toBe(1);
  });

  test('records schema version', () => {
    const row = ctx.bb.db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number } | null;
    expect(row).not.toBeNull();
    expect(row!.version).toBe(1);
  });

  test('is idempotent (opening same path twice works)', () => {
    const bb2 = new Blackboard(ctx.dbPath);
    const tables = bb2.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThanOrEqual(6);
    bb2.close();
  });

  test('custom path works', () => {
    const customDir = mkdtempSync(join(tmpdir(), 'bb-custom-'));
    const customPath = join(customDir, 'subdir', 'custom.db');
    const bbCustom = new Blackboard(customPath);
    const tables = bbCustom.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all() as { name: string }[];
    expect(tables.length).toBeGreaterThanOrEqual(6);
    bbCustom.close();
    rmSync(customDir, { recursive: true, force: true });
  });
});

describe('Agent lifecycle (delegated to ivy-blackboard)', () => {
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => { cleanupTestContext(ctx); });

  test('registerAgent creates agent with UUID session', () => {
    const result = ctx.bb.registerAgent({ name: 'Sentinel', project: 'ivy-heartbeat', work: 'Checking heartbeat' });
    expect(result.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.agent_name).toBe('Sentinel');
    expect(result.project).toBe('ivy-heartbeat');
    expect(result.current_work).toBe('Checking heartbeat');
    expect(result.status).toBe('active');
  });

  test('registerAgent works without optional fields', () => {
    const result = ctx.bb.registerAgent({ name: 'Worker' });
    expect(result.agent_name).toBe('Worker');
    expect(result.parent_id).toBeNull();
    expect(result.project).toBeNull();
    expect(result.current_work).toBeNull();
  });

  test('sendHeartbeat updates last_seen_at', () => {
    const agent = ctx.bb.registerAgent({ name: 'HeartbeatAgent' });
    const hbResult = ctx.bb.sendHeartbeat({ sessionId: agent.session_id, progress: 'Checking items' });
    expect(hbResult.session_id).toBe(agent.session_id);
    expect(hbResult.agent_name).toBe('HeartbeatAgent');
    expect(hbResult.progress).toBe('Checking items');
  });

  test('sendHeartbeat without progress', () => {
    const agent = ctx.bb.registerAgent({ name: 'SilentAgent' });
    const hbResult = ctx.bb.sendHeartbeat({ sessionId: agent.session_id });
    expect(hbResult.progress).toBeNull();
  });

  test('deregisterAgent sets status to completed', () => {
    const agent = ctx.bb.registerAgent({ name: 'DeregAgent' });
    const result = ctx.bb.deregisterAgent(agent.session_id);
    expect(result.session_id).toBe(agent.session_id);
    expect(result.agent_name).toBe('DeregAgent');
    expect(result.released_count).toBe(0);
    expect(result.duration_seconds).toBeGreaterThanOrEqual(0);

    const row = ctx.bb.db
      .prepare('SELECT status FROM agents WHERE session_id = ?')
      .get(agent.session_id) as { status: string };
    expect(row.status).toBe('completed');
  });

  test('sendHeartbeat throws for unknown session', () => {
    expect(() => {
      ctx.bb.sendHeartbeat({ sessionId: 'nonexistent' });
    }).toThrow(/Agent session not found/);
  });

  test('deregisterAgent throws for unknown session', () => {
    expect(() => {
      ctx.bb.deregisterAgent('nonexistent');
    }).toThrow(/Agent session not found/);
  });
});

describe('appendEvent', () => {
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => { cleanupTestContext(ctx); });

  test('appends event with heartbeat_received type', () => {
    const agent = ctx.bb.registerAgent({ name: 'EventAgent' });
    ctx.bb.appendEvent({
      actorId: agent.session_id,
      targetId: agent.session_id,
      summary: 'Calendar conflict detected',
    });

    const events = ctx.bb.eventQueries.getByType('heartbeat_received');
    // registerAgent also emits an agent_registered event
    // appendEvent adds a heartbeat_received event
    const hbEvents = events.filter(e => e.summary === 'Calendar conflict detected');
    expect(hbEvents.length).toBe(1);
    expect(hbEvents[0].actor_id).toBe(agent.session_id);
  });

  test('appends event with metadata', () => {
    ctx.bb.appendEvent({
      summary: 'Check completed',
      metadata: { severity: 'high', action: 'voice_alert' },
    });

    const events = ctx.bb.eventQueries.getRecent(1);
    expect(events.length).toBe(1);
    expect(events[0].metadata).not.toBeNull();
    const meta = JSON.parse(events[0].metadata!);
    expect(meta.severity).toBe('high');
  });

  test('appends event without optional fields', () => {
    ctx.bb.appendEvent({ summary: 'Minimal event' });

    const events = ctx.bb.eventQueries.getRecent(1);
    expect(events.length).toBe(1);
    expect(events[0].actor_id).toBeNull();
    expect(events[0].target_id).toBeNull();
    expect(events[0].metadata).toBeNull();
  });
});
