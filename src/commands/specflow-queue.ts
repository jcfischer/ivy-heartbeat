import { Command } from 'commander';
import type { CliContext } from '../cli.ts';

/**
 * CLI command: ivy-heartbeat specflow-queue
 *
 * Manually queue a SpecFlow feature for dispatch.
 * Creates the initial "specify" work item on the blackboard.
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

      // Check feature exists via specflow status
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
            const found = featureList.some(
              (f: { id?: string; feature_id?: string }) =>
                f.id === opts.feature || f.feature_id === opts.feature
            );

            if (!found && featureList.length > 0) {
              console.error(
                `Warning: feature "${opts.feature}" not found in specflow status. Proceeding anyway.`
              );
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

      // Create work item
      const itemId = `specflow-${opts.feature}-specify`;
      const metadata = {
        specflow_feature_id: opts.feature,
        specflow_phase: 'specify',
        specflow_project_id: opts.project,
      };

      try {
        bb.createWorkItem({
          id: itemId,
          title: `SpecFlow specify: ${opts.feature}`,
          description: `SpecFlow feature "${opts.feature}" — starting with specify phase (batch mode)`,
          project: opts.project,
          source: 'specflow',
          sourceRef: opts.feature,
          priority: opts.priority,
          metadata: JSON.stringify(metadata),
        });

        bb.appendEvent({
          targetId: itemId,
          summary: `Queued SpecFlow feature ${opts.feature} for dispatch (specify phase)`,
          metadata: { featureId: opts.feature, projectId: opts.project },
        });

        if (ctx.json) {
          console.log(JSON.stringify({ itemId, feature: opts.feature, phase: 'specify' }));
        } else {
          console.log(`Queued: ${opts.feature} → specify phase (item: ${itemId})`);
          console.log('The next dispatch cycle will pick it up.');
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error creating work item: ${msg}`);
        process.exit(1);
      }
    });
}
