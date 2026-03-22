import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';
import type { Blackboard } from '../blackboard.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';
import { sweepStaleAgents, type SweepConfig } from 'ivy-blackboard/src/sweep';
import { requeueWorkItem, getFailedItems } from 'ivy-blackboard/src/work';
import { getPRState } from '../scheduler/worktree.ts';

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

/**
 * Extract PR number and project path from a work item's metadata.
 * Returns null if the item has no PR association.
 */
function extractPRInfo(item: BlackboardWorkItem, bb: Blackboard): { prNumber: number; projectPath: string } | null {
  if (!item.metadata) return null;
  try {
    const meta = JSON.parse(item.metadata);
    const prNumber = meta.pr_number;
    if (typeof prNumber !== 'number') return null;

    // Resolve project path from the work item's project association
    const projectId = item.project_id;
    if (!projectId) return null;
    const project = bb.getProject(projectId);
    if (!project?.local_path) return null;

    return { prNumber, projectPath: project.local_path };
  } catch {
    return null;
  }
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

    // Requeue retriable failed tasks (skip items whose PR is already merged/closed)
    const requeuedTasks: string[] = [];
    const skippedStale: string[] = [];
    for (const failedItem of retriableItems) {
      try {
        // Check if this item is PR-related and the PR is no longer open
        const prInfo = extractPRInfo(failedItem, bbRef);
        if (prInfo) {
          const prState = await getPRState(prInfo.projectPath, prInfo.prNumber);
          if (prState === 'MERGED' || prState === 'CLOSED') {
            skippedStale.push(failedItem.item_id);
            continue;
          }
        }
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
    if (skippedStale.length > 0) {
      summaryParts.push(`${skippedStale.length} stale task(s) skipped (PR merged/closed)`);
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
        skippedStaleCount: skippedStale.length,
        staleAgents: sweepResult.staleAgents.map((a) => ({
          sessionId: a.sessionId,
          agentName: a.agentName,
          releasedItems: a.releasedItems,
        })),
        requeuedTasks: requeuedTasks.map((id) => ({ itemId: id })),
        skippedStaleTasks: skippedStale.map((id) => ({ itemId: id })),
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
