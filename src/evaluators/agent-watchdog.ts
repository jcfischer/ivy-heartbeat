import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';
import type { Blackboard } from '../blackboard.ts';
import { sweepStaleAgents, type SweepConfig } from 'ivy-blackboard/src/sweep';
import { requeueWorkItem, getFailedItems } from 'ivy-blackboard/src/work';

interface AgentWatchdogConfig {
  stuckThresholdMinutes: number;
  maxRetries: number;
}

function parseWatchdogConfig(item: ChecklistItem): AgentWatchdogConfig {
  return {
    stuckThresholdMinutes: typeof item.config.stuck_threshold_minutes === 'number' ? item.config.stuck_threshold_minutes : 30,
    maxRetries: typeof item.config.max_retries === 'number' ? item.config.max_retries : 2,
  };
}

// ─── Injectable blackboard accessor (set by runner) ──────────────────────

let bbRef: Blackboard | null = null;

export function setWatchdogBlackboard(bb: Blackboard): void {
  bbRef = bb;
}

export function resetWatchdogBlackboard(): void {
  bbRef = null;
}

/**
 * Evaluate agent watchdog: detect stuck agents and retry failed tasks.
 */
export async function evaluateAgentWatchdog(item: ChecklistItem): Promise<CheckResult> {
  if (!bbRef) {
    return {
      item,
      status: 'error',
      summary: `Agent watchdog: ${item.name} — blackboard not configured`,
      details: { error: 'Blackboard not set. Call setWatchdogBlackboard() before evaluating.' },
    };
  }

  const config = parseWatchdogConfig(item);

  try {
    // Convert minutes to seconds for sweep API
    const stuckThresholdSeconds = config.stuckThresholdMinutes * 60;
    const sweepConfig: SweepConfig = {
      staleThresholdSeconds: stuckThresholdSeconds,
    };

    // Detect and recover stuck agents
    const sweepResult = sweepStaleAgents(bbRef.db, sweepConfig);
    const staleAgentCount = sweepResult.staleAgents.length;
    const releasedItemCount = sweepResult.staleAgents.reduce((sum, agent) => sum + agent.releasedItems.length, 0);

    // Find failed tasks that can be retried
    const failedItems = getFailedItems(bbRef.db);
    const retriableItems = failedItems.filter(
      (item) => item.status === 'failed' && (item.failure_count ?? 0) < config.maxRetries
    );

    // Requeue retriable failed tasks
    const requeuedTasks: string[] = [];
    for (const failedItem of retriableItems) {
      try {
        requeueWorkItem(bbRef.db, failedItem.item_id);
        requeuedTasks.push(failedItem.item_id);
      } catch (err: unknown) {
        // Log but continue with other items
        console.error(`Failed to requeue ${failedItem.item_id}:`, err);
      }
    }

    const requeuedCount = requeuedTasks.length;

    // Determine status
    const hasRecovery = staleAgentCount > 0 || requeuedCount > 0;
    const status = hasRecovery ? 'alert' : 'ok';

    // Build summary
    const summaryParts: string[] = [];
    if (staleAgentCount > 0) {
      summaryParts.push(`${staleAgentCount} stuck agent(s) recovered`);
    }
    if (releasedItemCount > 0) {
      summaryParts.push(`${releasedItemCount} work item(s) released`);
    }
    if (requeuedCount > 0) {
      summaryParts.push(`${requeuedCount} failed task(s) requeued`);
    }

    const summary = summaryParts.length > 0
      ? `Agent watchdog: ${item.name} — ${summaryParts.join(', ')}`
      : `Agent watchdog: ${item.name} — no recovery needed`;

    return {
      item,
      status,
      summary,
      details: {
        staleAgentCount,
        releasedItemCount,
        requeuedCount,
        staleAgents: sweepResult.staleAgents.map((a) => ({
          sessionId: a.sessionId,
          agentName: a.agentName,
          releasedItems: a.releasedItems,
        })),
        requeuedTasks: requeuedTasks.map((id) => ({ itemId: id })),
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `Agent watchdog: ${item.name} — error: ${msg}`,
      details: { error: msg },
    };
  }
}
