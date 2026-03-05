/**
 * specflow-phase-worker — spawned by the orchestrator (fire-and-forget).
 *
 * Reads the active feature from the DB, runs the appropriate phase executor,
 * and updates the feature status. The orchestrator marks the feature `active`
 * before spawning this process, then returns immediately.
 */

import { Command } from 'commander';
import type { CliContext } from '../cli.ts';
import { SpecifyExecutor } from '../scheduler/specflow/phases/specify.ts';
import { PlanExecutor } from '../scheduler/specflow/phases/plan.ts';
import { TasksExecutor } from '../scheduler/specflow/phases/tasks.ts';
import { ImplementExecutor } from '../scheduler/specflow/phases/implement.ts';
import { CompleteExecutor } from '../scheduler/specflow/phases/complete.ts';
import type { PhaseExecutor } from '../scheduler/specflow/types.ts';

const EXECUTORS: PhaseExecutor[] = [
  new SpecifyExecutor(),
  new PlanExecutor(),
  new TasksExecutor(),
  new ImplementExecutor(),
  new CompleteExecutor(),
];

export function registerSpecFlowPhaseWorkerCommand(
  program: Command,
  getContext: () => CliContext,
): void {
  program
    .command('specflow-phase-worker')
    .description('Run a single specflow phase for a feature (spawned by orchestrator, not for direct use)')
    .requiredOption('--feature-id <id>', 'Feature ID to process')
    .requiredOption('--session-id <id>', 'Orchestrator session ID')
    .option('--timeout-ms <ms>', 'Phase timeout in milliseconds', '1800000')
    .action(async (opts) => {
      const { bb } = getContext();
      const featureId: string = opts.featureId;
      const sessionId: string = opts.sessionId;
      const timeoutMs = parseInt(opts.timeoutMs, 10);

      const feature = bb.getFeature(featureId);
      if (!feature) {
        console.error(`[specflow-phase-worker] Feature ${featureId} not found`);
        process.exit(1);
      }

      if (feature.status !== 'active') {
        // Already reset by orchestrator (e.g. stale timeout) — bail out cleanly
        console.error(`[specflow-phase-worker] Feature ${featureId} is not active (status: ${feature.status}), exiting`);
        process.exit(0);
      }

      const project = bb.getProject(feature.project_id);
      if (!project?.local_path) {
        bb.updateFeature(featureId, {
          status: 'pending',
          current_session: null,
          failure_count: feature.failure_count + 1,
          last_error: `Project "${feature.project_id}" not found or missing local_path`,
        });
        process.exit(1);
      }

      const worktreePath = feature.worktree_path;
      if (!worktreePath) {
        bb.updateFeature(featureId, {
          status: 'pending',
          current_session: null,
          failure_count: feature.failure_count + 1,
          last_error: 'No worktree_path set on feature (orchestrator should have set it)',
        });
        process.exit(1);
      }

      const executor = EXECUTORS.find(e => e.canRun(feature));
      if (!executor) {
        bb.updateFeature(featureId, {
          status: 'pending',
          current_session: null,
          failure_count: feature.failure_count + 1,
          last_error: `No executor available for phase "${feature.phase}"`,
        });
        process.exit(1);
      }

      bb.appendEvent({
        actorId: sessionId,
        targetId: featureId,
        summary: `[phase-worker] Running phase "${feature.phase}" for ${featureId}`,
        metadata: { phase: feature.phase, worktreePath, timeoutMs },
      });

      try {
        const result = await executor.execute(feature, bb, {
          worktreePath,
          projectPath: project.local_path,
          timeoutMs,
          sessionId,
          db: bb.db,
        });

        if (result.status === 'succeeded') {
          const updates: Parameters<typeof bb.updateFeature>[1] = {
            status: 'succeeded',
            current_session: null,
          };
          if (typeof result.metadata?.prNumber === 'number') updates.pr_number = result.metadata.prNumber;
          if (typeof result.metadata?.prUrl === 'string') updates.pr_url = result.metadata.prUrl;
          if (typeof result.metadata?.commitSha === 'string') updates.commit_sha = result.metadata.commitSha;
          bb.updateFeature(featureId, updates);
          bb.appendEvent({
            actorId: sessionId,
            targetId: featureId,
            summary: `Phase "${feature.phase}" succeeded for ${featureId}`,
            metadata: { phase: feature.phase, ...result.metadata },
          });
        } else {
          bb.updateFeature(featureId, {
            status: 'pending',
            current_session: null,
            failure_count: feature.failure_count + 1,
            last_error: result.error ?? `Phase "${feature.phase}" failed`,
          });
          bb.appendEvent({
            actorId: sessionId,
            targetId: featureId,
            summary: `Phase "${feature.phase}" failed for ${featureId}: ${result.error ?? 'unknown error'}`,
            metadata: { phase: feature.phase, error: result.error },
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bb.updateFeature(featureId, {
          status: 'pending',
          current_session: null,
          failure_count: feature.failure_count + 1,
          last_error: msg,
        });
        bb.appendEvent({
          actorId: sessionId,
          targetId: featureId,
          summary: `Phase "${feature.phase}" threw for ${featureId}: ${msg}`,
          metadata: { phase: feature.phase, error: msg },
        });
      }
    });
}
