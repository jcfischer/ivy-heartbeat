import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';

export interface CalendarEvent {
  title: string;
  start: string;  // ISO 8601
  end: string;    // ISO 8601
  calendar?: string;
}

interface CalendarConfig {
  lookaheadHours: number;
  calendarName?: string;
  conflictThreshold: number;
}

/**
 * Parse calendar config from a checklist item's config fields.
 */
export function parseCalendarConfig(item: ChecklistItem): CalendarConfig {
  return {
    lookaheadHours:
      typeof item.config.lookahead_hours === 'number'
        ? item.config.lookahead_hours
        : 24,
    calendarName:
      typeof item.config.calendar_name === 'string'
        ? item.config.calendar_name
        : undefined,
    conflictThreshold:
      typeof item.config.conflict_threshold === 'number'
        ? item.config.conflict_threshold
        : 1,
  };
}

/**
 * Detect overlapping events (conflicts) in a list of calendar events.
 * Two events conflict if one starts before the other ends.
 */
export function detectConflicts(events: CalendarEvent[]): Array<[CalendarEvent, CalendarEvent]> {
  const conflicts: Array<[CalendarEvent, CalendarEvent]> = [];

  // Sort by start time
  const sorted = [...events].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];

      const aEnd = new Date(a.end).getTime();
      const bStart = new Date(b.start).getTime();

      if (bStart < aEnd) {
        conflicts.push([a, b]);
      } else {
        // Since sorted, no more overlaps with a
        break;
      }
    }
  }

  return conflicts;
}

/**
 * Fetch calendar events via ical CLI.
 * Injectable for testing.
 */
export type CalendarFetcher = (config: CalendarConfig) => Promise<CalendarEvent[]>;

let calendarFetcher: CalendarFetcher = defaultCalendarFetcher;

async function defaultCalendarFetcher(config: CalendarConfig): Promise<CalendarEvent[]> {
  const icalPath = `${process.env.HOME}/.claude/skills/Calendar/ical`;

  try {
    const args = ['read', '--next', String(Math.ceil(config.lookaheadHours / 24)), '--format', 'json'];
    const proc = Bun.spawn([icalPath, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
      return [];
    }

    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) return [];

    return parsed.map((e: Record<string, unknown>) => ({
      title: String(e.title ?? e.summary ?? 'Untitled'),
      start: String(e.start ?? e.startDate ?? ''),
      end: String(e.end ?? e.endDate ?? ''),
      calendar: typeof e.calendar === 'string' ? e.calendar : undefined,
    })).filter((e: CalendarEvent) => e.start && e.end);
  } catch {
    return [];
  }
}

/**
 * Override the calendar fetcher (for testing).
 */
export function setCalendarFetcher(fetcher: CalendarFetcher): void {
  calendarFetcher = fetcher;
}

/**
 * Reset to default calendar fetcher.
 */
export function resetCalendarFetcher(): void {
  calendarFetcher = defaultCalendarFetcher;
}

/**
 * Evaluate calendar check for a checklist item.
 */
export async function evaluateCalendar(item: ChecklistItem): Promise<CheckResult> {
  const config = parseCalendarConfig(item);

  try {
    let events = await calendarFetcher(config);

    // Filter by calendar name if specified
    if (config.calendarName) {
      events = events.filter(
        (e) => e.calendar?.toLowerCase() === config.calendarName!.toLowerCase()
      );
    }

    // Filter to lookahead window
    const now = Date.now();
    const cutoff = now + config.lookaheadHours * 60 * 60 * 1000;
    events = events.filter((e) => {
      const start = new Date(e.start).getTime();
      return start >= now && start <= cutoff;
    });

    if (events.length === 0) {
      return {
        item,
        status: 'ok',
        summary: `Calendar check: ${item.name} — no events in next ${config.lookaheadHours}h`,
        details: { eventCount: 0, conflicts: 0 },
      };
    }

    const conflicts = detectConflicts(events);

    if (conflicts.length >= config.conflictThreshold) {
      const conflictDescriptions = conflicts.map(
        ([a, b]) => `"${a.title}" overlaps "${b.title}"`
      );
      return {
        item,
        status: 'alert',
        summary: `Calendar check: ${item.name} — ${conflicts.length} conflict(s) in next ${config.lookaheadHours}h`,
        details: {
          eventCount: events.length,
          conflicts: conflicts.length,
          conflictDetails: conflictDescriptions,
        },
      };
    }

    return {
      item,
      status: 'ok',
      summary: `Calendar check: ${item.name} — ${events.length} event(s), no conflicts in next ${config.lookaheadHours}h`,
      details: { eventCount: events.length, conflicts: 0 },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `Calendar check: ${item.name} — error: ${msg}`,
      details: { error: msg },
    };
  }
}
