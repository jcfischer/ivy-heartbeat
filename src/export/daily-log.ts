import type { Blackboard, BlackboardEvent } from '../blackboard.ts';

export interface DailyLogData {
  date: string;
  totalEvents: number;
  sessions: BlackboardEvent[];
  checks: BlackboardEvent[];
  facts: BlackboardEvent[];
  credentials: BlackboardEvent[];
  other: BlackboardEvent[];
}

/**
 * Collect events for a specific date and categorize them.
 */
export function collectDailyEvents(bb: Blackboard, date: string): DailyLogData {
  const dayStart = `${date}T00:00:00`;
  const dayEnd = `${date}T23:59:59`;

  // Get all events for the day
  const allEvents = bb.eventQueries.getSince(dayStart).filter(
    (e) => e.timestamp <= dayEnd
  );

  const sessions: BlackboardEvent[] = [];
  const checks: BlackboardEvent[] = [];
  const facts: BlackboardEvent[] = [];
  const credentials: BlackboardEvent[] = [];
  const other: BlackboardEvent[] = [];

  for (const event of allEvents) {
    const meta = event.metadata ?? '';

    if (meta.includes('"hookEvent"')) {
      if (meta.includes('session_started') || meta.includes('session_ended') || meta.includes('session_activity')) {
        sessions.push(event);
      } else if (meta.includes('fact_extracted') || meta.includes('pattern_detected')) {
        facts.push(event);
      } else {
        other.push(event);
      }
    } else if (meta.includes('"credentialEvent"')) {
      credentials.push(event);
    } else if (meta.includes('"checkName"') || meta.includes('"dispatched"')) {
      checks.push(event);
    } else {
      other.push(event);
    }
  }

  return {
    date,
    totalEvents: allEvents.length,
    sessions,
    checks,
    facts,
    credentials,
    other,
  };
}

/**
 * Generate Markdown daily log from collected events.
 */
export function generateDailyLog(data: DailyLogData): string {
  const lines: string[] = [];

  lines.push(`# Daily Log: ${data.date}`);
  lines.push('');
  lines.push(`**${data.totalEvents} events** recorded`);
  lines.push('');

  if (data.totalEvents === 0) {
    lines.push('No events recorded for this date.');
    return lines.join('\n');
  }

  // Summary counts
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Sessions: ${data.sessions.length}`);
  lines.push(`- Checks: ${data.checks.length}`);
  lines.push(`- Facts/Patterns: ${data.facts.length}`);
  lines.push(`- Credentials: ${data.credentials.length}`);
  lines.push(`- Other: ${data.other.length}`);
  lines.push('');

  // Sessions section
  if (data.sessions.length > 0) {
    lines.push('## Sessions');
    lines.push('');
    for (const e of data.sessions) {
      const time = e.timestamp.split('T')[1]?.slice(0, 5) ?? '';
      lines.push(`- **${time}** ${e.summary}`);
    }
    lines.push('');
  }

  // Checks section
  if (data.checks.length > 0) {
    lines.push('## Heartbeat Checks');
    lines.push('');
    for (const e of data.checks) {
      const time = e.timestamp.split('T')[1]?.slice(0, 5) ?? '';
      lines.push(`- **${time}** ${e.summary}`);
    }
    lines.push('');
  }

  // Facts section
  if (data.facts.length > 0) {
    lines.push('## Facts & Patterns');
    lines.push('');
    for (const e of data.facts) {
      lines.push(`- ${e.summary}`);
    }
    lines.push('');
  }

  // Credentials section
  if (data.credentials.length > 0) {
    lines.push('## Credential Events');
    lines.push('');
    for (const e of data.credentials) {
      const time = e.timestamp.split('T')[1]?.slice(0, 5) ?? '';
      lines.push(`- **${time}** ${e.summary}`);
    }
    lines.push('');
  }

  // Other section
  if (data.other.length > 0) {
    lines.push('## Other Events');
    lines.push('');
    for (const e of data.other) {
      const time = e.timestamp.split('T')[1]?.slice(0, 5) ?? '';
      lines.push(`- **${time}** ${e.summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
