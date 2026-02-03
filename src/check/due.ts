import type { ChecklistItem } from '../parser/types.ts';
import type { Blackboard } from '../blackboard.ts';
import type { DueCheckResult } from './types.ts';

const DEFAULT_INTERVAL_MINUTES = 60;

/**
 * Determine if a checklist item is due for evaluation.
 * Queries the blackboard for the most recent event matching this check name.
 */
export function isDue(item: ChecklistItem, bb: Blackboard): DueCheckResult {
  const intervalMinutes =
    typeof item.config.interval_minutes === 'number'
      ? item.config.interval_minutes
      : DEFAULT_INTERVAL_MINUTES;

  // Find the most recent event for this specific check
  const events = bb.eventQueries.getByType('heartbeat_received', { limit: 50 });
  const lastEvent = events.find(
    (e) => e.metadata && e.metadata.includes(`"checkName":"${item.name}"`)
  );

  if (!lastEvent) {
    return { item, isDue: true, lastRun: null, reason: 'never run' };
  }

  const lastRunTime = new Date(lastEvent.timestamp).getTime();
  const now = Date.now();
  const elapsedMs = now - lastRunTime;
  const elapsedMinutes = Math.round(elapsedMs / 60_000);
  const intervalMs = intervalMinutes * 60_000;

  if (elapsedMs >= intervalMs) {
    return {
      item,
      isDue: true,
      lastRun: lastEvent.timestamp,
      reason: `due (${elapsedMinutes}m since last)`,
    };
  }

  return {
    item,
    isDue: false,
    lastRun: lastEvent.timestamp,
    reason: `not due (${elapsedMinutes}m ago, interval: ${intervalMinutes}m)`,
  };
}
