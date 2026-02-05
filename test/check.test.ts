import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Blackboard } from '../src/blackboard.ts';
import { isDue } from '../src/check/due.ts';
import { runChecks } from '../src/check/runner.ts';
import { registerEvaluator } from '../src/check/evaluators.ts';
import { computeChecklistHash, shouldSkip } from '../src/check/guard.ts';
import type { ChecklistItem } from '../src/parser/types.ts';
import type { DueCheckResult } from '../src/check/types.ts';

interface TestCtx {
  tmpDir: string;
  dbPath: string;
  bb: Blackboard;
}

function createCtx(): TestCtx {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hb-check-'));
  const dbPath = join(tmpDir, 'test.db');
  const bb = new Blackboard(dbPath);
  return { tmpDir, dbPath, bb };
}

function cleanCtx(ctx: TestCtx): void {
  ctx.bb.close();
  rmSync(ctx.tmpDir, { recursive: true, force: true });
}

function makeItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    name: 'Test Check',
    type: 'custom',
    severity: 'medium',
    channels: ['terminal'],
    enabled: true,
    description: 'A test check',
    config: {},
    ...overrides,
  };
}

function writeChecklist(dir: string, content: string): string {
  const path = join(dir, 'heartbeat.md');
  writeFileSync(path, content, 'utf-8');
  return path;
}

const VALID_CHECKLIST = `# Ivy Heartbeat Checklist

## Calendar Conflicts
\`\`\`yaml
type: calendar
severity: medium
channels: [terminal]
enabled: true
description: Check for overlapping meetings
\`\`\`

## Email Alerts
\`\`\`yaml
type: email
severity: low
channels: [terminal]
enabled: true
description: Check for important emails
\`\`\`

## Disabled Check
\`\`\`yaml
type: custom
severity: low
channels: [terminal]
enabled: false
description: This one is disabled
\`\`\`
`;

let ctx: TestCtx;

// ── isDue tests ──────────────────────────────────────────────────────────

describe('isDue', () => {
  beforeEach(() => { ctx = createCtx(); });
  afterEach(() => { cleanCtx(ctx); });

  test('item with no previous run is due', () => {
    const item = makeItem({ name: 'Fresh Check' });
    const result = isDue(item, ctx.bb);
    expect(result.isDue).toBe(true);
    expect(result.lastRun).toBeNull();
    expect(result.reason).toBe('never run');
  });

  test('item run recently is not due', () => {
    const item = makeItem({ name: 'Recent Check' });
    const agent = ctx.bb.registerAgent({ name: 'test' });

    // Simulate a recent check event
    ctx.bb.appendEvent({
      actorId: agent.session_id,
      summary: 'Recent check result',
      metadata: { checkName: 'Recent Check', checkType: 'custom', status: 'ok' },
    });

    const result = isDue(item, ctx.bb);
    expect(result.isDue).toBe(false);
    expect(result.lastRun).not.toBeNull();
    expect(result.reason).toContain('not due');
  });

  test('item with custom interval_minutes', () => {
    const item = makeItem({
      name: 'Custom Interval',
      config: { interval_minutes: 0 }, // 0 minutes = always due
    });
    const agent = ctx.bb.registerAgent({ name: 'test' });

    ctx.bb.appendEvent({
      actorId: agent.session_id,
      summary: 'Previous run',
      metadata: { checkName: 'Custom Interval', checkType: 'custom', status: 'ok' },
    });

    const result = isDue(item, ctx.bb);
    expect(result.isDue).toBe(true);
    expect(result.reason).toContain('due');
  });
});

// ── runChecks tests ──────────────────────────────────────────────────────

describe('runChecks', () => {
  beforeEach(() => { ctx = createCtx(); });
  afterEach(() => { cleanCtx(ctx); });

  test('empty checklist returns gracefully', async () => {
    const configPath = writeChecklist(ctx.tmpDir, '# Empty\n');
    const agent = ctx.bb.registerAgent({ name: 'test' });

    const summary = await runChecks(ctx.bb, agent.session_id, { configPath });
    expect(summary.checked).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.disabled).toBe(0);
  });

  test('missing file returns empty', async () => {
    const agent = ctx.bb.registerAgent({ name: 'test' });
    const summary = await runChecks(ctx.bb, agent.session_id, {
      configPath: '/nonexistent/path/heartbeat.md',
    });
    expect(summary.checked).toBe(0);
  });

  test('all enabled items are evaluated', async () => {
    const configPath = writeChecklist(ctx.tmpDir, VALID_CHECKLIST);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    const summary = await runChecks(ctx.bb, agent.session_id, { configPath });
    // 2 enabled items (Calendar Conflicts, Email Alerts), 1 disabled
    expect(summary.checked).toBe(2);
    expect(summary.disabled).toBe(1);
    expect(summary.results.length).toBe(2);
    expect(summary.results.every((r) => r.status === 'ok')).toBe(true);
  });

  test('disabled items are skipped', async () => {
    const configPath = writeChecklist(ctx.tmpDir, VALID_CHECKLIST);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    const summary = await runChecks(ctx.bb, agent.session_id, { configPath });
    expect(summary.disabled).toBe(1);
    // Disabled item should not appear in results
    const names = summary.results.map((r) => r.item.name);
    expect(names).not.toContain('Disabled Check');
  });

  test('evaluator error is caught and logged', async () => {
    // Register a failing evaluator
    registerEvaluator('custom', async (item) => {
      throw new Error('Evaluator crashed');
    });

    const checklist = `# Test
## Crasher
\`\`\`yaml
type: custom
severity: high
channels: [terminal]
enabled: true
description: This will crash
\`\`\`
`;
    const configPath = writeChecklist(ctx.tmpDir, checklist);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    const summary = await runChecks(ctx.bb, agent.session_id, { configPath });
    expect(summary.checked).toBe(1);
    expect(summary.errors).toBe(1);
    expect(summary.results[0].status).toBe('error');
    expect(summary.results[0].summary).toContain('Evaluator crashed');

    // Restore stub evaluator
    registerEvaluator('custom', async (item) => ({
      item,
      status: 'ok',
      summary: `Custom check: ${item.name} (stub — ok)`,
    }));
  });

  test('results are recorded to blackboard', async () => {
    const configPath = writeChecklist(ctx.tmpDir, VALID_CHECKLIST);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    await runChecks(ctx.bb, agent.session_id, { configPath });

    // Check heartbeats were recorded
    const heartbeats = ctx.bb.heartbeatQueries.getBySession(agent.session_id);
    expect(heartbeats.length).toBe(2); // one per evaluated item

    // Check events were recorded
    const events = ctx.bb.eventQueries.getByType('heartbeat_received');
    // 2 check events + any from registerAgent sendHeartbeat
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  test('dry-run mode does not record results', async () => {
    const configPath = writeChecklist(ctx.tmpDir, VALID_CHECKLIST);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    const summary = await runChecks(ctx.bb, agent.session_id, {
      configPath,
      dryRun: true,
    });

    expect(summary.checked).toBe(0); // nothing evaluated
    expect(summary.dueResults.length).toBe(2); // but due status calculated
    expect(summary.dueResults.every((d) => d.isDue)).toBe(true);

    // No heartbeats recorded (beyond what registerAgent might do)
    const heartbeats = ctx.bb.heartbeatQueries.getBySession(agent.session_id);
    expect(heartbeats.length).toBe(0);
  });
});

// ── Agent lifecycle tests ────────────────────────────────────────────────

describe('check command agent lifecycle', () => {
  beforeEach(() => { ctx = createCtx(); });
  afterEach(() => { cleanCtx(ctx); });

  test('agent is registered and deregistered for check run', async () => {
    const configPath = writeChecklist(ctx.tmpDir, VALID_CHECKLIST);

    const agent = ctx.bb.registerAgent({
      name: 'ivy-heartbeat',
      project: 'heartbeat-check',
    });

    try {
      await runChecks(ctx.bb, agent.session_id, { configPath });
    } finally {
      ctx.bb.deregisterAgent(agent.session_id);
    }

    // Agent should be completed
    const row = ctx.bb.db
      .prepare('SELECT status FROM agents WHERE session_id = ?')
      .get(agent.session_id) as { status: string };
    expect(row.status).toBe('completed');
  });

  test('agent deregistered even when runChecks throws', async () => {
    const agent = ctx.bb.registerAgent({
      name: 'ivy-heartbeat',
      project: 'heartbeat-check',
    });

    // Force a throw by providing a broken evaluator and checklist
    registerEvaluator('calendar', async () => {
      throw new Error('forced failure');
    });

    const checklist = `# Test
## Cal Check
\`\`\`yaml
type: calendar
severity: high
channels: [terminal]
enabled: true
description: Will fail
\`\`\`
`;
    const configPath = writeChecklist(ctx.tmpDir, checklist);

    try {
      await runChecks(ctx.bb, agent.session_id, { configPath });
    } finally {
      ctx.bb.deregisterAgent(agent.session_id);
    }

    const row = ctx.bb.db
      .prepare('SELECT status FROM agents WHERE session_id = ?')
      .get(agent.session_id) as { status: string };
    expect(row.status).toBe('completed');

    // Restore stub
    registerEvaluator('calendar', async (item) => ({
      item,
      status: 'ok',
      summary: `Calendar check: ${item.name} (stub)`,
    }));
  });
});

// ── Cost guard tests ────────────────────────────────────────────────────

describe('computeChecklistHash', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hb-guard-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns a hex string for valid file', () => {
    const path = join(tmpDir, 'checklist.md');
    writeFileSync(path, '# Test checklist\ncontent here', 'utf-8');
    const hash = computeChecklistHash(path);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64); // SHA-256 hex = 64 chars
  });

  test('same content produces same hash', () => {
    const p1 = join(tmpDir, 'a.md');
    const p2 = join(tmpDir, 'b.md');
    writeFileSync(p1, 'identical content', 'utf-8');
    writeFileSync(p2, 'identical content', 'utf-8');
    expect(computeChecklistHash(p1)).toBe(computeChecklistHash(p2));
  });

  test('different content produces different hash', () => {
    const p1 = join(tmpDir, 'a.md');
    const p2 = join(tmpDir, 'b.md');
    writeFileSync(p1, 'content A', 'utf-8');
    writeFileSync(p2, 'content B', 'utf-8');
    expect(computeChecklistHash(p1)).not.toBe(computeChecklistHash(p2));
  });

  test('returns empty string for missing file', () => {
    const hash = computeChecklistHash('/nonexistent/file.md');
    expect(hash).toBe('');
  });
});

describe('shouldSkip', () => {
  test('returns skip=true when no items are due', () => {
    const dueResults: DueCheckResult[] = [
      { item: makeItem({ name: 'A' }), isDue: false, lastRun: '2026-01-01T00:00:00Z', reason: 'not due (10m ago)' },
      { item: makeItem({ name: 'B' }), isDue: false, lastRun: '2026-01-01T00:00:00Z', reason: 'not due (5m ago)' },
    ];
    const result = shouldSkip(dueResults);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('no_items_due');
  });

  test('returns skip=false when some items are due', () => {
    const dueResults: DueCheckResult[] = [
      { item: makeItem({ name: 'A' }), isDue: true, lastRun: null, reason: 'never run' },
      { item: makeItem({ name: 'B' }), isDue: false, lastRun: '2026-01-01T00:00:00Z', reason: 'not due' },
    ];
    const result = shouldSkip(dueResults);
    expect(result.skip).toBe(false);
    expect(result.reason).toBe('items_due');
  });

  test('returns skip=false when all items are due', () => {
    const dueResults: DueCheckResult[] = [
      { item: makeItem({ name: 'A' }), isDue: true, lastRun: null, reason: 'never run' },
    ];
    const result = shouldSkip(dueResults);
    expect(result.skip).toBe(false);
  });

  test('returns skip=true for empty array', () => {
    const result = shouldSkip([]);
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('no_items_due');
  });
});

describe('cost guard integration', () => {
  beforeEach(() => { ctx = createCtx(); });
  afterEach(() => { cleanCtx(ctx); });

  test('guard skips when all items were recently checked', async () => {
    const configPath = writeChecklist(ctx.tmpDir, VALID_CHECKLIST);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    // First run: evaluates all items
    const first = await runChecks(ctx.bb, agent.session_id, { configPath });
    expect(first.checked).toBe(2);
    expect(first.guardSkipped).toBeFalsy();

    // Second run: guard should skip (all items recently checked)
    const second = await runChecks(ctx.bb, agent.session_id, { configPath });
    expect(second.guardSkipped).toBe(true);
    expect(second.checked).toBe(0);
    expect(second.results.length).toBe(0);
  });

  test('guard records skip event to blackboard', async () => {
    const configPath = writeChecklist(ctx.tmpDir, VALID_CHECKLIST);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    // First run evaluates
    await runChecks(ctx.bb, agent.session_id, { configPath });

    // Second run skips
    await runChecks(ctx.bb, agent.session_id, { configPath });

    // Find the skip event
    const events = ctx.bb.eventQueries.getByType('heartbeat_received');
    const skipEvents = events.filter((e) => {
      const meta = typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata);
      return meta.includes('no_items_due');
    });
    expect(skipEvents.length).toBeGreaterThanOrEqual(1);
  });

  test('guard includes checklist hash in skip event', async () => {
    const configPath = writeChecklist(ctx.tmpDir, VALID_CHECKLIST);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    await runChecks(ctx.bb, agent.session_id, { configPath });
    await runChecks(ctx.bb, agent.session_id, { configPath });

    const events = ctx.bb.eventQueries.getByType('heartbeat_received');
    const skipEvents = events.filter((e) => {
      const meta = typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata);
      return meta.includes('checklistHash');
    });
    expect(skipEvents.length).toBeGreaterThanOrEqual(1);
  });

  test('force flag bypasses guard', async () => {
    const configPath = writeChecklist(ctx.tmpDir, VALID_CHECKLIST);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    // First run
    await runChecks(ctx.bb, agent.session_id, { configPath });

    // Second run with force: should NOT skip, all items run regardless of due status
    const second = await runChecks(ctx.bb, agent.session_id, { configPath, force: true });
    expect(second.guardSkipped).toBeFalsy();
    expect(second.skipped).toBe(0);
    expect(second.checked).toBe(2);
  });

  test('guard does not interfere with dry-run', async () => {
    const configPath = writeChecklist(ctx.tmpDir, VALID_CHECKLIST);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    // dry-run returns before guard check
    const summary = await runChecks(ctx.bb, agent.session_id, { configPath, dryRun: true });
    expect(summary.checked).toBe(0);
    expect(summary.dueResults.length).toBe(2);
  });

  test('guard summary includes enabledCount', async () => {
    const configPath = writeChecklist(ctx.tmpDir, VALID_CHECKLIST);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    await runChecks(ctx.bb, agent.session_id, { configPath });
    const second = await runChecks(ctx.bb, agent.session_id, { configPath });
    expect(second.guardSkipped).toBe(true);
    // enabledCount should be 2 (Calendar Conflicts + Email Alerts)
    expect(second.guardResult?.enabledCount).toBe(2);
  });
});
