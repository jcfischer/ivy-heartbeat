import { Command } from 'commander';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { CliContext } from '../cli.ts';
import type { SpecFlowPhase } from '../scheduler/specflow-types.ts';
import { findFeatureDir } from '../scheduler/specflow/utils/find-feature-dir.ts';

/** Artifact that proves a phase is complete */
const PHASE_ARTIFACT: Partial<Record<SpecFlowPhase, string>> = {
  specify: 'spec.md',
  plan: 'plan.md',
  tasks: 'tasks.md',
};

/**
 * Detect the correct starting phase based on existing artifacts on disk.
 * Returns the first phase whose artifact does NOT yet exist.
 */
function detectStartPhase(
  projectPath: string,
  featureId: string
): { phase: SpecFlowPhase; found: string[] } {
  const specDir = join(projectPath, '.specify', 'specs');
  const featureDir = findFeatureDir(specDir, featureId);

  if (!featureDir) {
    return { phase: 'specify', found: [] };
  }

  const found: string[] = [];

  if (existsSync(join(featureDir, 'spec.md'))) found.push('spec.md');
  if (existsSync(join(featureDir, 'plan.md'))) found.push('plan.md');
  if (existsSync(join(featureDir, 'tasks.md'))) found.push('tasks.md');

  if (found.length === 0) return { phase: 'specify', found };
  if (!found.includes('spec.md')) return { phase: 'specify', found };
  if (!found.includes('plan.md')) return { phase: 'plan', found };
  if (!found.includes('tasks.md')) return { phase: 'tasks', found };
  return { phase: 'implement', found };
}

/**
 * CLI command: ivy-heartbeat specflow-queue
 *
 * Manually queue a SpecFlow feature for dispatch.
 * Auto-detects the starting phase from existing artifacts on disk.
 */
export function registerSpecFlowQueueCommand(
  parent: Command,
  getContext: () => CliContext
): void {
  parent
    .command('specflow-queue')
    .description('Queue a SpecFlow feature for dispatch')
    .requiredOption('--project <id>', 'Project ID (must have specflow_enabled)')
    .requiredOption('--feature <id>', 'SpecFlow feature ID (e.g., F-019)')
    .option('--priority <n>', 'Priority level', 'P2')
    .action(async (opts) => {
      const ctx = getContext();
      const bb = ctx.bb;

      // Validate project exists
      const project = bb.getProject(opts.project);
      if (!project) {
        console.error(`Error: project "${opts.project}" not found on blackboard`);
        process.exit(1);
      }

      // Validate project has specflow_enabled
      let projectMeta: Record<string, unknown> = {};
      if (project.metadata) {
        try {
          projectMeta = JSON.parse(project.metadata as string);
        } catch {
          // Invalid metadata JSON
        }
      }

      if (!projectMeta.specflow_enabled) {
        console.error(
          `Error: project "${opts.project}" does not have specflow_enabled in metadata.\n` +
          `Set it with: blackboard project register --name ${opts.project} --metadata '{"specflow_enabled": true}'`
        );
        process.exit(1);
      }

      // Validate specflow CLI is available
      try {
        const proc = Bun.spawn(['which', 'specflow'], {
          stdout: 'pipe',
          stderr: 'pipe',
        });
        await proc.exited;
        if (proc.exitCode !== 0) {
          throw new Error('not found');
        }
      } catch {
        console.error('Error: specflow CLI not found. Ensure ~/bin/specflow exists and is in PATH.');
        process.exit(1);
      }

      // Check feature exists via specflow status and fix stale status
      if (project.local_path) {
        try {
          const proc = Bun.spawn(['specflow', 'status', '--json'], {
            cwd: project.local_path,
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const output = await new Response(proc.stdout).text();
          await proc.exited;

          if (proc.exitCode === 0) {
            const status = JSON.parse(output);
            const features = status.features ?? status;
            const featureList = Array.isArray(features) ? features : [];
            const feature = featureList.find(
              (f: { id?: string; feature_id?: string }) =>
                f.id === opts.feature || f.feature_id === opts.feature
            );

            if (!feature && featureList.length > 0) {
              console.error(
                `Warning: feature "${opts.feature}" not found in specflow status. Proceeding anyway.`
              );
            }

            // Reset stale "complete" status if the feature hasn't actually
            // been through all phases (no completedAt timestamp)
            if (feature && feature.status === 'complete' && !feature.completedAt) {
              console.log(`Resetting stale "complete" status for ${opts.feature} (no completion timestamp)`);
              const resetProc = Bun.spawn(['specflow', 'reset', opts.feature], {
                cwd: project.local_path,
                stdout: 'pipe',
                stderr: 'pipe',
              });
              await resetProc.exited;
            }
          }
        } catch {
          // Non-fatal — proceed even if specflow status fails
        }
      }

      // Check for duplicate work items
      const existingItems = bb.listWorkItems({ all: true, project: opts.project });
      const duplicate = existingItems.some((item) => {
        if (!item.metadata) return false;
        try {
          const meta = JSON.parse(item.metadata);
          return (
            meta.specflow_feature_id === opts.feature &&
            item.status !== 'completed' &&
            item.status !== 'failed'
          );
        } catch {
          return false;
        }
      });

      if (duplicate) {
        console.error(
          `Error: an active SpecFlow work item already exists for feature "${opts.feature}" in project "${opts.project}"`
        );
        process.exit(1);
      }

      // Detect starting phase from existing artifacts
      const detected = project.local_path
        ? detectStartPhase(project.local_path, opts.feature)
        : { phase: 'specify' as SpecFlowPhase, found: [] as string[] };

      const startPhase = detected.phase;

      if (detected.found.length > 0) {
        console.log(`Existing artifacts found: ${detected.found.join(', ')}`);
        console.log(`Starting at phase: ${startPhase} (skipping completed phases)`);
      }

      // ─── Advance specflow DB phase to match detected artifacts ─────
      // When existing artifacts are found, the specflow DB may still be
      // at an earlier phase (e.g., "none"). The runner's prerequisite
      // check will block unless we advance the DB to match.
      if (detected.found.length > 0 && project.local_path) {
        try {
          // Get current DB phase for this feature
          const statusProc = Bun.spawn(['specflow', 'status', '--json'], {
            cwd: project.local_path,
            stdout: 'pipe',
            stderr: 'pipe',
          });
          const statusOutput = await new Response(statusProc.stdout).text();
          await statusProc.exited;

          if (statusProc.exitCode === 0) {
            const statusData = JSON.parse(statusOutput);
            const features = statusData.features ?? statusData;
            const featureList = Array.isArray(features) ? features : [];
            const feature = featureList.find(
              (f: { id?: string; feature_id?: string }) =>
                f.id === opts.feature || f.feature_id === opts.feature
            );

            const dbPhase = feature?.phase ?? 'none';
            const phaseOrder: Record<string, number> = {
              none: 0, specify: 1, plan: 2, tasks: 3, implement: 4, complete: 5,
            };
            const dbPhaseIdx = phaseOrder[dbPhase] ?? 0;

            // Advance DB through each phase whose artifact exists on disk.
            // E.g., if spec.md + plan.md exist and DB is at "none", advance
            // through specify → plan so the runner's prerequisite check passes.
            for (const [phase, artifact] of Object.entries(PHASE_ARTIFACT)) {
              const idx = phaseOrder[phase] ?? 0;
              if (idx > dbPhaseIdx && detected.found.includes(artifact!)) {
                console.log(`Advancing specflow DB: ${opts.feature} → phase ${phase}`);
                const advProc = Bun.spawn(['specflow', 'phase', opts.feature, phase], {
                  cwd: project.local_path,
                  stdout: 'pipe',
                  stderr: 'pipe',
                });
                await advProc.exited;
              }
            }

            // ─── Fix spec_path if it points to a file instead of directory ──
            if (feature?.specPath && feature.specPath.endsWith('.md')) {
              const dirPath = feature.specPath.replace(/\/[^/]+\.md$/, '');
              console.log(`Fixing spec_path: ${feature.specPath} → ${dirPath}`);
              const editProc = Bun.spawn(['specflow', 'edit', opts.feature, '--spec-path', dirPath], {
                cwd: project.local_path,
                stdout: 'pipe',
                stderr: 'pipe',
              });
              await editProc.exited;
            }
          }
        } catch {
          // Non-fatal — the runner's prerequisite check will handle it
          console.log('Warning: could not advance specflow DB phases (non-fatal)');
        }
      }

      // Create work item
      const itemId = `specflow-${opts.feature}-${startPhase}`;
      const metadata = {
        specflow_feature_id: opts.feature,
        specflow_phase: startPhase,
        specflow_project_id: opts.project,
      };

      try {
        bb.createWorkItem({
          id: itemId,
          title: `SpecFlow ${startPhase}: ${opts.feature}`,
          description: `SpecFlow feature "${opts.feature}" — starting with ${startPhase} phase${detected.found.length > 0 ? ` (existing: ${detected.found.join(', ')})` : ' (batch mode)'}`,
          project: opts.project,
          source: 'specflow',
          sourceRef: opts.feature,
          priority: opts.priority,
          metadata: JSON.stringify(metadata),
        });

        bb.appendEvent({
          targetId: itemId,
          summary: `Queued SpecFlow feature ${opts.feature} for dispatch (${startPhase} phase)`,
          metadata: { featureId: opts.feature, projectId: opts.project, phase: startPhase, existingArtifacts: detected.found },
        });

        if (ctx.json) {
          console.log(JSON.stringify({ itemId, feature: opts.feature, phase: startPhase, existingArtifacts: detected.found }));
        } else {
          console.log(`Queued: ${opts.feature} → ${startPhase} phase (item: ${itemId})`);
          console.log('The next dispatch cycle will pick it up.');
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error creating work item: ${msg}`);
        process.exit(1);
      }
    });
}
