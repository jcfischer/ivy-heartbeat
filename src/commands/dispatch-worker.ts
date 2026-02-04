import { Command } from 'commander';
import type { CliContext } from '../cli.ts';
import { getLauncher, logPathForSession } from '../scheduler/launcher.ts';

/**
 * Build the prompt for a Claude Code session working on a work item.
 * (Mirrors scheduler.ts buildPrompt but reads item from blackboard.)
 */
function buildPrompt(
  title: string,
  description: string | null,
  itemId: string,
  sessionId: string
): string {
  const parts = [`You are an autonomous agent working on: ${title}`];

  if (description) {
    parts.push(`\nDescription: ${description}`);
  }

  parts.push(
    `\nWork item ID: ${itemId}`,
    `Session ID: ${sessionId}`,
    `\nWhen you are done, summarize what you accomplished.`
  );

  return parts.join('\n');
}

/**
 * Hidden dispatch-worker subcommand.
 *
 * Spawned as a detached process by dispatch() in fire-and-forget mode.
 * Handles the full agent lifecycle:
 *   1. Read work item + project from blackboard
 *   2. Run Claude Code via the launcher
 *   3. On success: complete work item + deregister agent
 *   4. On failure: release work item + deregister agent
 */
export function registerDispatchWorkerCommand(
  parent: Command,
  getContext: () => CliContext
): void {
  parent
    .command('dispatch-worker')
    .description('[internal] Run a single dispatched work item')
    .option('--session-id <id>', 'Agent session ID')
    .option('--item-id <id>', 'Work item ID')
    .option('--timeout-ms <ms>', 'Timeout in milliseconds', '3600000')
    .action(async (opts) => {
      const sessionId = opts.sessionId;
      const itemId = opts.itemId;
      const timeoutMs = parseInt(opts.timeoutMs, 10);

      if (!sessionId || !itemId) {
        console.error('dispatch-worker: --session-id and --item-id are required');
        process.exit(1);
      }

      const ctx = getContext();
      const bb = ctx.bb;
      const launcher = getLauncher();

      // Read work item from blackboard
      const items = bb.listWorkItems({ status: 'claimed' });
      const item = items.find((i) => i.item_id === itemId);

      if (!item) {
        bb.appendEvent({
          actorId: sessionId,
          targetId: itemId,
          summary: `Worker: work item "${itemId}" not found or not claimed`,
        });
        try { bb.deregisterAgent(sessionId); } catch { /* best effort */ }
        process.exit(1);
      }

      // Resolve project path
      const project = item.project_id ? bb.getProject(item.project_id) : null;
      if (!project?.local_path) {
        bb.appendEvent({
          actorId: sessionId,
          targetId: itemId,
          summary: `Worker: no local_path for project "${item.project_id}"`,
        });
        try { bb.releaseWorkItem(itemId, sessionId); } catch { /* best effort */ }
        try { bb.deregisterAgent(sessionId); } catch { /* best effort */ }
        process.exit(1);
      }

      const prompt = buildPrompt(item.title, item.description, itemId, sessionId);
      const startTime = Date.now();

      bb.appendEvent({
        actorId: sessionId,
        targetId: itemId,
        summary: `Worker started for "${item.title}" in ${project.local_path}`,
        metadata: { itemId, projectId: item.project_id, pid: process.pid },
      });

      try {
        const result = await launcher({
          workDir: project.local_path,
          prompt,
          timeoutMs,
          sessionId,
        });

        const durationMs = Date.now() - startTime;

        if (result.exitCode === 0) {
          bb.completeWorkItem(itemId, sessionId);
          bb.appendEvent({
            actorId: sessionId,
            targetId: itemId,
            summary: `Completed "${item.title}" (exit 0, ${Math.round(durationMs / 1000)}s)`,
            metadata: { itemId, exitCode: 0, durationMs },
          });
        } else {
          bb.releaseWorkItem(itemId, sessionId);
          bb.appendEvent({
            actorId: sessionId,
            targetId: itemId,
            summary: `Failed "${item.title}" (exit ${result.exitCode}, ${Math.round(durationMs / 1000)}s)`,
            metadata: {
              itemId,
              exitCode: result.exitCode,
              durationMs,
              stderr: result.stderr.slice(0, 500),
            },
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startTime;

        try { bb.releaseWorkItem(itemId, sessionId); } catch { /* best effort */ }

        bb.appendEvent({
          actorId: sessionId,
          targetId: itemId,
          summary: `Worker error for "${item.title}": ${msg}`,
          metadata: { itemId, error: msg, durationMs },
        });
      } finally {
        try { bb.deregisterAgent(sessionId); } catch { /* best effort */ }
      }
    });
}
