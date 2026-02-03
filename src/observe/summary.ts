import type { Blackboard, BlackboardEvent } from '../blackboard.ts';

export interface ObserveSummary {
  totalEvents: number;
  eventsByType: Record<string, number>;
  lastHeartbeat: string | null;
  activeAgents: number;
  recentChecks: Array<{
    name: string;
    status: string;
    time: string;
  }>;
}

/**
 * Generate an aggregate summary of blackboard state.
 */
export function generateSummary(bb: Blackboard): ObserveSummary {
  const events = bb.eventQueries.getRecent(200);

  // Count by type
  const eventsByType: Record<string, number> = {};
  for (const e of events) {
    eventsByType[e.event_type] = (eventsByType[e.event_type] ?? 0) + 1;
  }

  // Last heartbeat
  const lastHb = bb.heartbeatQueries.getLatest();
  const lastHeartbeat = lastHb?.timestamp ?? null;

  // Active agents
  const agentIds = new Set<string>();
  for (const e of events) {
    if (e.actor_id) agentIds.add(e.actor_id);
  }

  // Recent checks (from events with checkName metadata)
  const recentChecks: ObserveSummary['recentChecks'] = [];
  const seenChecks = new Set<string>();
  for (const e of events) {
    if (!e.metadata) continue;
    try {
      const meta = JSON.parse(e.metadata);
      if (meta.checkName && !seenChecks.has(meta.checkName)) {
        seenChecks.add(meta.checkName);
        recentChecks.push({
          name: meta.checkName,
          status: meta.status ?? 'unknown',
          time: e.timestamp,
        });
      }
    } catch {
      // Skip unparseable metadata
    }
  }

  return {
    totalEvents: events.length,
    eventsByType,
    lastHeartbeat,
    activeAgents: agentIds.size,
    recentChecks: recentChecks.slice(0, 10),
  };
}

/**
 * Format summary as text for CLI output.
 */
export function formatSummaryText(summary: ObserveSummary): string {
  const lines: string[] = [];

  lines.push('ivy-heartbeat dashboard');
  lines.push('═══════════════════════');
  lines.push('');
  lines.push(`  Events (recent):    ${summary.totalEvents}`);
  lines.push(`  Active agents:      ${summary.activeAgents}`);
  lines.push(`  Last heartbeat:     ${summary.lastHeartbeat ?? 'never'}`);
  lines.push('');

  if (Object.keys(summary.eventsByType).length > 0) {
    lines.push('  Events by type:');
    for (const [type, count] of Object.entries(summary.eventsByType)) {
      lines.push(`    ${type}: ${count}`);
    }
    lines.push('');
  }

  if (summary.recentChecks.length > 0) {
    lines.push('  Recent checks:');
    for (const check of summary.recentChecks) {
      const icon = check.status === 'ok' ? '✓' : check.status === 'alert' ? '!' : '✗';
      const time = check.time.split('T')[1]?.slice(0, 5) ?? '';
      lines.push(`    ${icon} ${check.name} (${check.status}) at ${time}`);
    }
  }

  return lines.join('\n');
}
