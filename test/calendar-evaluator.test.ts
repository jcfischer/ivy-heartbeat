import { describe, test, expect, afterEach } from 'bun:test';
import {
  evaluateCalendar,
  parseCalendarConfig,
  detectConflicts,
  setCalendarFetcher,
  resetCalendarFetcher,
  type CalendarEvent,
} from '../src/evaluators/calendar.ts';
import type { ChecklistItem } from '../src/parser/types.ts';

function makeItem(config: Record<string, unknown> = {}): ChecklistItem {
  return {
    name: 'Calendar Conflicts',
    type: 'calendar',
    severity: 'high',
    channels: ['terminal', 'voice'],
    enabled: true,
    description: 'Check for scheduling conflicts',
    config,
  };
}

// Helper: create events relative to now
function futureEvent(title: string, offsetHours: number, durationHours: number): CalendarEvent {
  const start = new Date(Date.now() + offsetHours * 3600_000);
  const end = new Date(start.getTime() + durationHours * 3600_000);
  return { title, start: start.toISOString(), end: end.toISOString() };
}

describe('parseCalendarConfig', () => {
  test('returns defaults when no config', () => {
    const config = parseCalendarConfig(makeItem());
    expect(config.lookaheadHours).toBe(24);
    expect(config.conflictThreshold).toBe(1);
    expect(config.calendarName).toBeUndefined();
  });

  test('reads custom config values', () => {
    const config = parseCalendarConfig(makeItem({
      lookahead_hours: 48,
      calendar_name: 'Work',
      conflict_threshold: 2,
    }));
    expect(config.lookaheadHours).toBe(48);
    expect(config.calendarName).toBe('Work');
    expect(config.conflictThreshold).toBe(2);
  });
});

describe('detectConflicts', () => {
  test('no conflicts with non-overlapping events', () => {
    const events: CalendarEvent[] = [
      { title: 'A', start: '2026-02-03T10:00:00Z', end: '2026-02-03T11:00:00Z' },
      { title: 'B', start: '2026-02-03T11:00:00Z', end: '2026-02-03T12:00:00Z' },
    ];
    expect(detectConflicts(events)).toHaveLength(0);
  });

  test('detects overlapping events', () => {
    const events: CalendarEvent[] = [
      { title: 'Meeting A', start: '2026-02-03T10:00:00Z', end: '2026-02-03T11:30:00Z' },
      { title: 'Meeting B', start: '2026-02-03T11:00:00Z', end: '2026-02-03T12:00:00Z' },
    ];
    const conflicts = detectConflicts(events);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0][0].title).toBe('Meeting A');
    expect(conflicts[0][1].title).toBe('Meeting B');
  });

  test('detects multiple conflicts', () => {
    const events: CalendarEvent[] = [
      { title: 'A', start: '2026-02-03T10:00:00Z', end: '2026-02-03T12:00:00Z' },
      { title: 'B', start: '2026-02-03T11:00:00Z', end: '2026-02-03T13:00:00Z' },
      { title: 'C', start: '2026-02-03T11:30:00Z', end: '2026-02-03T12:30:00Z' },
    ];
    const conflicts = detectConflicts(events);
    expect(conflicts.length).toBeGreaterThanOrEqual(2); // A-B, A-C, possibly B-C
  });

  test('empty events returns no conflicts', () => {
    expect(detectConflicts([])).toHaveLength(0);
  });

  test('single event returns no conflicts', () => {
    const events: CalendarEvent[] = [
      { title: 'Solo', start: '2026-02-03T10:00:00Z', end: '2026-02-03T11:00:00Z' },
    ];
    expect(detectConflicts(events)).toHaveLength(0);
  });
});

describe('evaluateCalendar', () => {
  afterEach(() => {
    resetCalendarFetcher();
  });

  test('returns ok when no events', async () => {
    setCalendarFetcher(async () => []);

    const result = await evaluateCalendar(makeItem());
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('no events');
  });

  test('returns ok when events but no conflicts', async () => {
    setCalendarFetcher(async () => [
      futureEvent('Meeting 1', 2, 1),
      futureEvent('Meeting 2', 4, 1),
    ]);

    const result = await evaluateCalendar(makeItem());
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('2 event(s)');
    expect(result.summary).toContain('no conflicts');
  });

  test('returns alert when conflicts detected', async () => {
    setCalendarFetcher(async () => [
      futureEvent('Meeting A', 2, 2),
      futureEvent('Meeting B', 3, 1),
    ]);

    const result = await evaluateCalendar(makeItem());
    expect(result.status).toBe('alert');
    expect(result.summary).toContain('conflict');
  });

  test('respects conflict threshold', async () => {
    setCalendarFetcher(async () => [
      futureEvent('A', 2, 2),
      futureEvent('B', 3, 1),
    ]);

    // Threshold of 2 — single conflict should be ok
    const result = await evaluateCalendar(makeItem({ conflict_threshold: 2 }));
    expect(result.status).toBe('ok');
  });

  test('filters by calendar name', async () => {
    setCalendarFetcher(async () => [
      { ...futureEvent('Work Meeting', 2, 2), calendar: 'Work' },
      { ...futureEvent('Personal', 3, 1), calendar: 'Personal' },
    ]);

    // Only check Work calendar — no overlap within Work
    const result = await evaluateCalendar(makeItem({ calendar_name: 'Work' }));
    expect(result.status).toBe('ok');
  });

  test('handles fetcher error gracefully', async () => {
    setCalendarFetcher(async () => { throw new Error('Calendar unavailable'); });

    const result = await evaluateCalendar(makeItem());
    expect(result.status).toBe('error');
    expect(result.summary).toContain('Calendar unavailable');
  });

  test('filters events outside lookahead window', async () => {
    setCalendarFetcher(async () => [
      futureEvent('Soon', 1, 1),
      futureEvent('Far away', 100, 1), // 100 hours from now
    ]);

    const result = await evaluateCalendar(makeItem({ lookahead_hours: 24 }));
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('1 event(s)');
  });
});
