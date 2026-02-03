import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Blackboard } from '../src/blackboard.ts';
import { collectDailyEvents, generateDailyLog } from '../src/export/daily-log.ts';

describe('daily log export', () => {
  let bb: Blackboard;
  let tmpDir: string;
  const today = new Date().toISOString().split('T')[0];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hb-log-'));
    bb = new Blackboard(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    bb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty log for date with no events', () => {
    const data = collectDailyEvents(bb, '2020-01-01');
    expect(data.totalEvents).toBe(0);

    const log = generateDailyLog(data);
    expect(log).toContain('# Daily Log: 2020-01-01');
    expect(log).toContain('No events recorded');
  });

  test('categorizes check events correctly', () => {
    bb.appendEvent({
      summary: 'Calendar check passed',
      metadata: { checkName: 'Calendar', status: 'ok' },
    });

    const data = collectDailyEvents(bb, today);
    expect(data.checks.length).toBe(1);
    expect(data.sessions.length).toBe(0);
  });

  test('categorizes session events correctly', () => {
    bb.appendEvent({
      summary: 'Session started: /test/project',
      metadata: { hookEvent: 'session_started', sessionId: 'abc' },
    });

    bb.appendEvent({
      summary: 'Session ended: /test/project',
      metadata: { hookEvent: 'session_ended', sessionId: 'abc' },
    });

    const data = collectDailyEvents(bb, today);
    expect(data.sessions.length).toBe(2);
  });

  test('categorizes fact events correctly', () => {
    bb.appendEvent({
      summary: 'Fact extracted: SQLite is the right choice',
      metadata: { hookEvent: 'fact_extracted', text: 'SQLite' },
    });

    const data = collectDailyEvents(bb, today);
    expect(data.facts.length).toBe(1);
  });

  test('categorizes credential events correctly', () => {
    bb.appendEvent({
      summary: 'Credential accessed: smtp by email',
      metadata: { credentialEvent: true, outcome: 'accessed' },
    });

    const data = collectDailyEvents(bb, today);
    expect(data.credentials.length).toBe(1);
  });

  test('generates markdown with all sections', () => {
    bb.appendEvent({
      summary: 'Session started',
      metadata: { hookEvent: 'session_started' },
    });
    bb.appendEvent({
      summary: 'Check passed: Calendar',
      metadata: { checkName: 'Calendar', status: 'ok' },
    });
    bb.appendEvent({
      summary: 'Fact: uses TypeScript',
      metadata: { hookEvent: 'fact_extracted' },
    });

    const data = collectDailyEvents(bb, today);
    const log = generateDailyLog(data);

    expect(log).toContain('# Daily Log:');
    expect(log).toContain('## Summary');
    expect(log).toContain('## Sessions');
    expect(log).toContain('## Heartbeat Checks');
    expect(log).toContain('## Facts & Patterns');
    expect(log).toContain('**3 events**');
  });

  test('omits empty sections', () => {
    bb.appendEvent({
      summary: 'Check passed',
      metadata: { checkName: 'Test', status: 'ok' },
    });

    const data = collectDailyEvents(bb, today);
    const log = generateDailyLog(data);

    expect(log).toContain('## Heartbeat Checks');
    expect(log).not.toContain('## Sessions');
    expect(log).not.toContain('## Credential Events');
  });

  test('does not include events from other dates', () => {
    bb.appendEvent({
      summary: 'Today event',
      metadata: { checkName: 'Today' },
    });

    const data = collectDailyEvents(bb, '2020-01-01');
    expect(data.totalEvents).toBe(0);
  });

  test('collectDailyEvents returns correct totals', () => {
    for (let i = 0; i < 5; i++) {
      bb.appendEvent({
        summary: `Event ${i}`,
        metadata: { checkName: `Check ${i}` },
      });
    }

    const data = collectDailyEvents(bb, today);
    expect(data.totalEvents).toBe(5);
  });
});
