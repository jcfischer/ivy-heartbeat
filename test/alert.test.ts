import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isWithinActiveHours } from '../src/alert/hours.ts';
import { notifyEmail } from '../src/alert/email.ts';
import { dispatchAlert } from '../src/alert/dispatcher.ts';
import { Blackboard } from '../src/blackboard.ts';
import { runChecks } from '../src/check/runner.ts';
import { registerEvaluator } from '../src/check/evaluators.ts';
import type { CheckResult } from '../src/check/types.ts';
import type { ChecklistItem } from '../src/parser/types.ts';

function makeResult(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    item: {
      name: 'Test Check',
      type: 'custom',
      severity: 'medium',
      channels: ['terminal'],
      enabled: true,
      description: 'A test check',
      config: {},
    },
    status: 'alert',
    summary: 'Something needs attention',
    ...overrides,
  };
}

// ── Active hours tests ──────────────────────────────────────────────────

describe('isWithinActiveHours', () => {
  test('returns true during default active hours (10:00)', () => {
    const date = new Date('2026-02-03T10:00:00');
    expect(isWithinActiveHours(date)).toBe(true);
  });

  test('returns true at start boundary (08:00)', () => {
    const date = new Date('2026-02-03T08:00:00');
    expect(isWithinActiveHours(date)).toBe(true);
  });

  test('returns false at end boundary (22:00)', () => {
    const date = new Date('2026-02-03T22:00:00');
    expect(isWithinActiveHours(date)).toBe(false);
  });

  test('returns false before active hours (06:00)', () => {
    const date = new Date('2026-02-03T06:00:00');
    expect(isWithinActiveHours(date)).toBe(false);
  });

  test('returns false after active hours (23:00)', () => {
    const date = new Date('2026-02-03T23:00:00');
    expect(isWithinActiveHours(date)).toBe(false);
  });

  test('respects custom config', () => {
    const date = new Date('2026-02-03T06:00:00');
    // Outside default but inside custom 05:00–20:00
    expect(isWithinActiveHours(date, { start: 5, end: 20 })).toBe(true);
  });

  test('midnight is outside default hours', () => {
    const date = new Date('2026-02-03T00:00:00');
    expect(isWithinActiveHours(date)).toBe(false);
  });
});

// ── Email stub tests ────────────────────────────────────────────────────

describe('notifyEmail', () => {
  test('stub returns false (not configured)', async () => {
    const result = makeResult();
    expect(await notifyEmail(result)).toBe(false);
  });
});

// ── Dispatcher tests ────────────────────────────────────────────────────

describe('dispatchAlert', () => {
  test('routes to terminal channel', async () => {
    const result = makeResult();
    const dispatch = await dispatchAlert(result, ['terminal'], { start: 0, end: 24 });
    // osascript should work on macOS
    expect(dispatch.delivered.length + dispatch.failed.length).toBe(1);
    expect(dispatch.suppressed.length).toBe(0);
  });

  test('email stub results in failed delivery', async () => {
    const result = makeResult();
    const dispatch = await dispatchAlert(result, ['email'], { start: 0, end: 24 });
    expect(dispatch.failed.length).toBe(1);
    expect(dispatch.failed[0].channel).toBe('email');
    expect(dispatch.delivered).not.toContain('email');
  });

  test('multiple channels fire independently', async () => {
    const result = makeResult();
    const dispatch = await dispatchAlert(result, ['terminal', 'email'], { start: 0, end: 24 });
    // Both attempted: terminal may succeed, email always fails
    const total = dispatch.delivered.length + dispatch.failed.length;
    expect(total).toBe(2);
  });

  test('suppresses all channels outside active hours', async () => {
    const result = makeResult();
    // Force outside active hours: 02:00–03:00 window, current time is anything outside
    const dispatch = await dispatchAlert(result, ['terminal', 'voice'], { start: 2, end: 3 });
    expect(dispatch.suppressed.length).toBe(2);
    expect(dispatch.delivered.length).toBe(0);
    expect(dispatch.failed.length).toBe(0);
  });

  test('empty channels array returns empty result', async () => {
    const result = makeResult();
    const dispatch = await dispatchAlert(result, []);
    expect(dispatch.delivered.length).toBe(0);
    expect(dispatch.failed.length).toBe(0);
    expect(dispatch.suppressed.length).toBe(0);
  });
});

// ── Runner integration tests ────────────────────────────────────────────

describe('alert dispatch integration', () => {
  interface TestCtx {
    tmpDir: string;
    bb: Blackboard;
  }

  let ctx: TestCtx;

  function writeChecklist(dir: string, content: string): string {
    const path = join(dir, 'heartbeat.md');
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  beforeEach(() => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hb-alert-'));
    const dbPath = join(tmpDir, 'test.db');
    ctx = { tmpDir, bb: new Blackboard(dbPath) };
  });

  afterEach(() => {
    ctx.bb.close();
    rmSync(ctx.tmpDir, { recursive: true, force: true });
  });

  test('ok results do not trigger dispatch events', async () => {
    const checklist = `# Test
## Good Check
\`\`\`yaml
type: custom
severity: low
channels: [terminal]
enabled: true
description: This is fine
\`\`\`
`;
    const configPath = writeChecklist(ctx.tmpDir, checklist);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    await runChecks(ctx.bb, agent.session_id, { configPath });

    const events = ctx.bb.eventQueries.getByType('heartbeat_received');
    const dispatchEvents = events.filter((e) => {
      const meta = typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata);
      return meta.includes('"dispatched"');
    });
    expect(dispatchEvents.length).toBe(0);
  });

  test('alert results trigger dispatch events', async () => {
    // Register an evaluator that returns alert
    registerEvaluator('custom', async (item) => ({
      item,
      status: 'alert',
      summary: `Alert: ${item.name} needs attention`,
    }));

    const checklist = `# Test
## Alert Check
\`\`\`yaml
type: custom
severity: high
channels: [terminal]
enabled: true
description: Will alert
\`\`\`
`;
    const configPath = writeChecklist(ctx.tmpDir, checklist);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    const summary = await runChecks(ctx.bb, agent.session_id, { configPath });
    expect(summary.alerts).toBe(1);

    // Should have a dispatch event recorded
    const events = ctx.bb.eventQueries.getByType('heartbeat_received');
    const dispatchEvents = events.filter((e) => {
      const meta = typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata);
      return meta.includes('"dispatched"');
    });
    expect(dispatchEvents.length).toBe(1);

    // Restore stub
    registerEvaluator('custom', async (item) => ({
      item,
      status: 'ok',
      summary: `Custom check: ${item.name} (stub — ok)`,
    }));
  });

  test('error results also trigger dispatch events', async () => {
    registerEvaluator('custom', async (item) => {
      throw new Error('Evaluator crashed');
    });

    const checklist = `# Test
## Error Check
\`\`\`yaml
type: custom
severity: high
channels: [terminal]
enabled: true
description: Will error
\`\`\`
`;
    const configPath = writeChecklist(ctx.tmpDir, checklist);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    const summary = await runChecks(ctx.bb, agent.session_id, { configPath });
    expect(summary.errors).toBe(1);

    const events = ctx.bb.eventQueries.getByType('heartbeat_received');
    const dispatchEvents = events.filter((e) => {
      const meta = typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata);
      return meta.includes('"dispatched"');
    });
    expect(dispatchEvents.length).toBe(1);

    // Restore stub
    registerEvaluator('custom', async (item) => ({
      item,
      status: 'ok',
      summary: `Custom check: ${item.name} (stub — ok)`,
    }));
  });

  test('dry-run does not dispatch alerts', async () => {
    registerEvaluator('custom', async (item) => ({
      item,
      status: 'alert',
      summary: `Alert: ${item.name}`,
    }));

    const checklist = `# Test
## Alert Check
\`\`\`yaml
type: custom
severity: high
channels: [terminal]
enabled: true
description: Would alert
\`\`\`
`;
    const configPath = writeChecklist(ctx.tmpDir, checklist);
    const agent = ctx.bb.registerAgent({ name: 'test' });

    const summary = await runChecks(ctx.bb, agent.session_id, { configPath, dryRun: true });
    // Dry run doesn't evaluate, so no alerts or dispatch
    expect(summary.checked).toBe(0);
    expect(summary.alerts).toBe(0);

    const events = ctx.bb.eventQueries.getByType('heartbeat_received');
    const dispatchEvents = events.filter((e) => {
      const meta = typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata);
      return meta.includes('"dispatched"');
    });
    expect(dispatchEvents.length).toBe(0);

    // Restore stub
    registerEvaluator('custom', async (item) => ({
      item,
      status: 'ok',
      summary: `Custom check: ${item.name} (stub — ok)`,
    }));
  });
});
