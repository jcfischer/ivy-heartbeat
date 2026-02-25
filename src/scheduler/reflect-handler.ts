import type { Database } from 'bun:sqlite';
import type { Blackboard } from '../blackboard.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';
import { parseReflectMeta, runReflect } from './reflect.ts';

/**
 * Handle a reflect work item (lesson extraction from merged PR).
 * Shared by both scheduler.ts (synchronous mode) and dispatch-worker.ts (fire-and-forget mode).
 *
 * @param bb Blackboard instance
 * @param item Work item with reflect metadata
 * @param sessionId Agent session ID for event logging
 * @param sendHeartbeat Optional heartbeat callback (used by worker, not scheduler)
 * @returns true if successful and work item was completed, false if failed/released
 */
export async function handleReflectWorkItem(
  bb: Blackboard,
  item: BlackboardWorkItem,
  sessionId: string,
  sendHeartbeat?: (msg: string) => void
): Promise<boolean> {
  const reflectMeta = parseReflectMeta(JSON.parse(item.metadata || '{}'));

  if (!reflectMeta) {
    return false; // Not a reflect work item
  }

  const startTime = Date.now();

  // Heartbeat before work (worker only)
  if (sendHeartbeat) {
    sendHeartbeat(`Extracting lessons from PR #${reflectMeta.pr_number}`);
  }

  try {
    await runReflect(bb.db, reflectMeta);
    bb.completeWorkItem(item.item_id, sessionId);
    const durationMs = Date.now() - startTime;

    // Heartbeat after work (worker only)
    if (sendHeartbeat) {
      sendHeartbeat(`Reflect completed for PR #${reflectMeta.pr_number} (${Math.round(durationMs / 1000)}s)`);
    }

    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Reflect phase completed for PR #${reflectMeta.pr_number} (${Math.round(durationMs / 1000)}s)`,
      metadata: { prNumber: reflectMeta.pr_number, durationMs },
    });

    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;
    try { bb.releaseWorkItem(item.item_id, sessionId); } catch { /* best effort */ }

    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Reflect phase failed for PR #${reflectMeta.pr_number}: ${msg}`,
      metadata: { error: msg, durationMs },
    });

    return false;
  }
}
