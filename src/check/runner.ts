import type { Blackboard } from '../blackboard.ts';
import { parseHeartbeatChecklist } from '../parser/heartbeat-parser.ts';
import { isDue } from './due.ts';
import { getEvaluator } from './evaluators.ts';
import { computeChecklistHash, shouldSkip } from './guard.ts';
import { dispatchAlert } from '../alert/dispatcher.ts';
import { setBlackboardAccessor, resetBlackboardAccessor } from '../evaluators/github-issues.ts';
import { setTanaBlackboardAccessor, resetTanaBlackboardAccessor } from '../evaluators/tana-todos.ts';
import { setDispatchBlackboard, resetDispatchBlackboard } from '../evaluators/agent-dispatch.ts';
import { setWatcherBlackboardAccessor, resetWatcherBlackboardAccessor } from '../evaluators/github-issue-watcher.ts';
import { setPrReviewBlackboardAccessor, resetPrReviewBlackboardAccessor } from '../evaluators/github-pr-review.ts';
import { setCleanupBlackboard, resetCleanupBlackboard } from '../evaluators/specflow-cleanup.ts';
import { setOrchestratorBlackboard, resetOrchestratorBlackboard } from '../evaluators/specflow-orchestrate.ts';
import { setReviewCycleAccessor, resetReviewCycleAccessor } from '../scheduler/worktree.ts';
import type {
  CheckOptions,
  CheckResult,
  CheckSummary,
  DueCheckResult,
} from './types.ts';

/**
 * Run the heartbeat check pipeline:
 * 1. Load checklist
 * 2. Filter enabled items
 * 3. Check which are due
 * 4. Cost guard: skip if nothing due
 * 5. Evaluate due items
 * 6. Record results to blackboard
 */
export async function runChecks(
  bb: Blackboard,
  sessionId: string,
  opts: CheckOptions = {}
): Promise<CheckSummary> {
  const items = parseHeartbeatChecklist(opts.configPath);

  const enabled = items.filter((item) => item.enabled);
  const disabledCount = items.length - enabled.length;

  // Check due status for all enabled items (--force overrides to all due)
  const dueResults: DueCheckResult[] = opts.force
    ? enabled.map((item) => ({ item, isDue: true, lastRun: null, reason: 'forced' }))
    : enabled.map((item) => isDue(item, bb));

  // In dry-run mode, return without evaluating
  if (opts.dryRun) {
    return {
      timestamp: new Date().toISOString(),
      checked: 0,
      alerts: 0,
      errors: 0,
      skipped: dueResults.filter((d) => !d.isDue).length,
      disabled: disabledCount,
      results: [],
      dueResults,
    };
  }

  // Cost guard: skip if nothing is due (unless --force)
  if (!opts.force) {
    const guardResult = shouldSkip(dueResults);
    guardResult.checklistHash = computeChecklistHash(opts.configPath ?? '');

    if (guardResult.skip) {
      // Record skip event
      bb.appendEvent({
        actorId: sessionId,
        summary: `Heartbeat skipped: no items due`,
        metadata: {
          checklistHash: guardResult.checklistHash,
          enabledCount: guardResult.enabledCount,
          reason: 'no_items_due',
        },
      });

      return {
        timestamp: new Date().toISOString(),
        checked: 0,
        alerts: 0,
        errors: 0,
        skipped: dueResults.length,
        disabled: disabledCount,
        results: [],
        dueResults,
        guardSkipped: true,
        guardResult,
      };
    }
  }

  // Make blackboard available to evaluators that need it
  setBlackboardAccessor(bb);
  setTanaBlackboardAccessor(bb);
  setDispatchBlackboard(bb);
  setWatcherBlackboardAccessor(bb);
  setPrReviewBlackboardAccessor(bb);
  setCleanupBlackboard(bb);
  setOrchestratorBlackboard(bb);
  setReviewCycleAccessor(bb);

  const results: CheckResult[] = [];
  let alerts = 0;
  let errors = 0;
  let skipped = 0;

  for (const dueResult of dueResults) {
    if (!dueResult.isDue) {
      skipped++;
      continue;
    }

    const evaluator = getEvaluator(dueResult.item.type);
    let result: CheckResult;

    try {
      result = await evaluator(dueResult.item);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        item: dueResult.item,
        status: 'error',
        summary: `Error evaluating ${dueResult.item.name}: ${msg}`,
        details: { error: msg },
      };
    }

    results.push(result);

    if (result.status === 'alert') alerts++;
    if (result.status === 'error') errors++;

    // Record heartbeat progress
    bb.sendHeartbeat({ sessionId, progress: result.summary });

    // Record event with check metadata
    bb.appendEvent({
      actorId: sessionId,
      targetId: sessionId,
      summary: result.summary,
      metadata: {
        checkName: dueResult.item.name,
        checkType: dueResult.item.type,
        status: result.status,
        severity: dueResult.item.severity,
        ...result.details,
      },
    });

    // Dispatch alerts for non-ok results
    if (result.status === 'alert' || result.status === 'error') {
      const dispatchResult = await dispatchAlert(result, dueResult.item.channels);

      bb.appendEvent({
        actorId: sessionId,
        summary: `Alert dispatched: ${result.item.name} via ${dispatchResult.delivered.join(', ') || 'none'}`,
        metadata: {
          checkName: result.item.name,
          dispatched: true,
          delivered: dispatchResult.delivered,
          failed: dispatchResult.failed,
          suppressed: dispatchResult.suppressed,
        },
      });
    }
  }

  resetBlackboardAccessor();
  resetTanaBlackboardAccessor();
  resetDispatchBlackboard();
  resetWatcherBlackboardAccessor();
  resetPrReviewBlackboardAccessor();
  resetCleanupBlackboard();
  resetOrchestratorBlackboard();
  resetReviewCycleAccessor();

  return {
    timestamp: new Date().toISOString(),
    checked: results.length,
    alerts,
    errors,
    skipped,
    disabled: disabledCount,
    results,
    dueResults,
  };
}
