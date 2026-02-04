import type { Blackboard } from '../blackboard.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';
import { getLauncher, logPathForSession } from './launcher.ts';
import type {
  DispatchOptions,
  DispatchResult,
  DispatchedItem,
  SkippedItem,
} from './types.ts';

/**
 * Count currently active agents (active or idle) on the blackboard.
 */
function countActiveAgents(bb: Blackboard): number {
  const row = bb.db
    .query("SELECT COUNT(*) as count FROM agents WHERE status IN ('active', 'idle')")
    .get() as { count: number };
  return row.count;
}

/**
 * Build the prompt for a Claude Code session working on a work item.
 */
function buildPrompt(item: BlackboardWorkItem, sessionId: string): string {
  const parts = [
    `You are an autonomous agent working on: ${item.title}`,
  ];

  if (item.description) {
    parts.push(`\nDescription: ${item.description}`);
  }

  parts.push(
    `\nWork item ID: ${item.item_id}`,
    `Session ID: ${sessionId}`,
    `\nWhen you are done, summarize what you accomplished.`,
  );

  return parts.join('\n');
}

/**
 * Dispatch available work items to Claude Code sessions.
 *
 * Pipeline:
 * 1. Query blackboard for available work, ordered by priority
 * 2. Filter by project/priority if specified
 * 3. Check concurrency limits
 * 4. For each item (up to maxItems):
 *    a. Look up project local_path
 *    b. Register agent + claim work
 *    c. Launch Claude Code session
 *    d. On success: complete work + deregister
 *    e. On failure: release work + deregister
 */
export async function dispatch(
  bb: Blackboard,
  opts: DispatchOptions
): Promise<DispatchResult> {
  const result: DispatchResult = {
    timestamp: new Date().toISOString(),
    dispatched: [],
    skipped: [],
    errors: [],
    dryRun: opts.dryRun,
  };

  // Query available work items
  const items = bb.listWorkItems({
    status: 'available',
    priority: opts.priority,
    project: opts.project,
  });

  if (items.length === 0) {
    return result;
  }

  // Check concurrency limit (pre-existing agents, not ones we'll create)
  if (!opts.dryRun) {
    const activeCount = countActiveAgents(bb);
    if (activeCount >= opts.maxConcurrent) {
      for (const item of items) {
        result.skipped.push({
          itemId: item.item_id,
          title: item.title,
          reason: `concurrency limit reached (${activeCount}/${opts.maxConcurrent} active)`,
        });
      }
      return result;
    }
  }

  // Cap by maxItems only — sequential processing means each completion frees the slot
  const itemsToProcess = items.slice(0, opts.maxItems);
  const itemsSkipped = items.slice(opts.maxItems);

  // Skip remaining items beyond limit
  for (const item of itemsSkipped) {
    result.skipped.push({
      itemId: item.item_id,
      title: item.title,
      reason: 'exceeds max items per run',
    });
  }

  // Dry run: report what would be dispatched
  if (opts.dryRun) {
    for (const item of itemsToProcess) {
      const project = item.project_id ? bb.getProject(item.project_id) : null;
      if (!project?.local_path) {
        result.skipped.push({
          itemId: item.item_id,
          title: item.title,
          reason: item.project_id
            ? `project "${item.project_id}" has no local_path`
            : 'no project assigned',
        });
      } else {
        result.dispatched.push({
          itemId: item.item_id,
          title: item.title,
          projectId: item.project_id!,
          sessionId: '(dry-run)',
          exitCode: 0,
          completed: false,
          durationMs: 0,
        });
      }
    }
    return result;
  }

  // Process items sequentially
  const launcher = getLauncher();

  for (const item of itemsToProcess) {
    // Validate project has a local_path
    const project = item.project_id ? bb.getProject(item.project_id) : null;

    if (!project?.local_path) {
      result.skipped.push({
        itemId: item.item_id,
        title: item.title,
        reason: item.project_id
          ? `project "${item.project_id}" has no local_path`
          : 'no project assigned',
      });
      continue;
    }

    // Register agent and claim work
    let sessionId: string;
    try {
      const agent = bb.registerAgent({
        name: `dispatch-${item.item_id}`,
        project: item.project_id!,
        work: item.item_id,
      });
      sessionId = agent.session_id;

      // Store log path in agent metadata
      const logPath = logPathForSession(sessionId);
      bb.db
        .query("UPDATE agents SET metadata = ? WHERE session_id = ?")
        .run(JSON.stringify({ logPath }), sessionId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({
        itemId: item.item_id,
        title: item.title,
        error: `Failed to register agent: ${msg}`,
      });
      continue;
    }

    const claimResult = bb.claimWorkItem(item.item_id, sessionId);
    if (!claimResult.claimed) {
      result.skipped.push({
        itemId: item.item_id,
        title: item.title,
        reason: 'could not claim (already claimed by another agent)',
      });
      bb.deregisterAgent(sessionId);
      continue;
    }

    // Log dispatch event
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Dispatching "${item.title}" to Claude Code in ${project.local_path}`,
      metadata: {
        itemId: item.item_id,
        projectId: item.project_id,
        priority: item.priority,
        workDir: project.local_path,
      },
    });

    // Launch Claude Code session
    const startTime = Date.now();
    const prompt = buildPrompt(item, sessionId);

    try {
      const launchResult = await launcher({
        workDir: project.local_path,
        prompt,
        timeoutMs: opts.timeout * 60 * 1000,
        sessionId,
      });

      const durationMs = Date.now() - startTime;

      if (launchResult.exitCode === 0) {
        // Success: complete the work item
        bb.completeWorkItem(item.item_id, sessionId);

        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Completed "${item.title}" (exit 0, ${Math.round(durationMs / 1000)}s)`,
          metadata: {
            itemId: item.item_id,
            exitCode: 0,
            durationMs,
          },
        });

        result.dispatched.push({
          itemId: item.item_id,
          title: item.title,
          projectId: item.project_id!,
          sessionId,
          exitCode: 0,
          completed: true,
          durationMs,
        });
      } else {
        // Non-zero exit: release work back to available
        bb.releaseWorkItem(item.item_id, sessionId);

        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Failed "${item.title}" (exit ${launchResult.exitCode}, ${Math.round(durationMs / 1000)}s)`,
          metadata: {
            itemId: item.item_id,
            exitCode: launchResult.exitCode,
            durationMs,
            stderr: launchResult.stderr.slice(0, 500),
          },
        });

        result.errors.push({
          itemId: item.item_id,
          title: item.title,
          error: `Claude exited with code ${launchResult.exitCode}`,
        });
      }

      bb.deregisterAgent(sessionId);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;

      // Release work on exception
      try {
        bb.releaseWorkItem(item.item_id, sessionId);
      } catch {
        // Best effort — item may already be released by sweep
      }

      try {
        bb.deregisterAgent(sessionId);
      } catch {
        // Best effort
      }

      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Error dispatching "${item.title}": ${msg}`,
        metadata: { itemId: item.item_id, error: msg, durationMs },
      });

      result.errors.push({
        itemId: item.item_id,
        title: item.title,
        error: msg,
      });
    }
  }

  return result;
}
