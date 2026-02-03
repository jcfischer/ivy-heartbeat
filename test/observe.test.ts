import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Blackboard } from '../src/blackboard.ts';
import { generateSummary, formatSummaryText } from '../src/observe/summary.ts';

describe('observe summary', () => {
  let bb: Blackboard;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hb-obs-'));
    bb = new Blackboard(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    bb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns zeros for empty blackboard', () => {
    const summary = generateSummary(bb);
    expect(summary.totalEvents).toBe(0);
    expect(summary.activeAgents).toBe(0);
    expect(summary.lastHeartbeat).toBeNull();
    expect(summary.recentChecks).toHaveLength(0);
  });

  test('counts events', () => {
    bb.appendEvent({ summary: 'Event 1' });
    bb.appendEvent({ summary: 'Event 2' });
    bb.appendEvent({ summary: 'Event 3' });

    const summary = generateSummary(bb);
    expect(summary.totalEvents).toBe(3);
  });

  test('counts events by type', () => {
    bb.appendEvent({ summary: 'A' });
    bb.appendEvent({ summary: 'B' });

    const summary = generateSummary(bb);
    expect(summary.eventsByType['heartbeat_received']).toBe(2);
  });

  test('tracks active agents', () => {
    const agent1 = bb.registerAgent({ name: 'agent1' });
    const agent2 = bb.registerAgent({ name: 'agent2' });

    bb.appendEvent({ actorId: agent1.session_id, summary: 'Work 1' });
    bb.appendEvent({ actorId: agent2.session_id, summary: 'Work 2' });

    const summary = generateSummary(bb);
    expect(summary.activeAgents).toBeGreaterThanOrEqual(2);
  });

  test('shows last heartbeat time', () => {
    const agent = bb.registerAgent({ name: 'test' });
    bb.sendHeartbeat({ sessionId: agent.session_id, progress: 'Working' });

    const summary = generateSummary(bb);
    expect(summary.lastHeartbeat).not.toBeNull();
  });

  test('extracts recent checks from event metadata', () => {
    bb.appendEvent({
      summary: 'Calendar check passed',
      metadata: { checkName: 'Calendar', status: 'ok' },
    });
    bb.appendEvent({
      summary: 'Email alert',
      metadata: { checkName: 'Email', status: 'alert' },
    });

    const summary = generateSummary(bb);
    expect(summary.recentChecks.length).toBe(2);
    expect(summary.recentChecks.some((c) => c.name === 'Calendar')).toBe(true);
    expect(summary.recentChecks.some((c) => c.name === 'Email')).toBe(true);
  });

  test('deduplicates checks by name', () => {
    bb.appendEvent({ summary: 'Check 1', metadata: { checkName: 'Calendar', status: 'ok' } });
    bb.appendEvent({ summary: 'Check 2', metadata: { checkName: 'Calendar', status: 'ok' } });

    const summary = generateSummary(bb);
    const calChecks = summary.recentChecks.filter((c) => c.name === 'Calendar');
    expect(calChecks.length).toBe(1);
  });

  test('formatSummaryText produces readable output', () => {
    bb.appendEvent({ summary: 'Check ok', metadata: { checkName: 'Calendar', status: 'ok' } });
    const agent = bb.registerAgent({ name: 'test' });
    bb.sendHeartbeat({ sessionId: agent.session_id });

    const summary = generateSummary(bb);
    const text = formatSummaryText(summary);

    expect(text).toContain('ivy-heartbeat dashboard');
    expect(text).toContain('Events (recent)');
    expect(text).toContain('Active agents');
    expect(text).toContain('Last heartbeat');
    expect(text).toContain('Recent checks');
  });
});
