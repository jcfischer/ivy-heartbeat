import { Command } from 'commander';
import type { CliContext } from '../cli.ts';
import { runChecks } from '../check/runner.ts';
import { formatJson } from 'ivy-blackboard/src/output';
import type { CheckResult, CheckSummary, DueCheckResult } from '../check/types.ts';

export function registerCheckCommand(
  parent: Command,
  getContext: () => CliContext
): void {
  parent
    .command('check')
    .description('Run heartbeat checks')
    .option('--once', 'Run checks once and exit (default)')
    .option('--config <path>', 'Custom checklist path')
    .option('--dry-run', 'Show what would run without evaluating')
    .option('--force', 'Force evaluation even if nothing is due')
    .option('--verbose', 'Show detailed output per check')
    .action(async (opts) => {
      const ctx = getContext();
      const bb = ctx.bb;

      // Register agent for this check run
      const agent = bb.registerAgent({
        name: 'ivy-heartbeat',
        project: 'heartbeat-check',
        work: 'Running heartbeat checks',
      });

      try {
        const summary = await runChecks(bb, agent.session_id, {
          configPath: opts.config,
          dryRun: opts.dryRun,
          force: opts.force,
          verbose: opts.verbose,
        });

        if (ctx.json) {
          console.log(formatJson(summary));
        } else if (opts.dryRun) {
          printDryRun(summary.dueResults, summary.disabled);
        } else if (summary.guardSkipped) {
          printSkipped(summary);
        } else {
          printSummary(summary.results, summary.dueResults, summary);
        }

        // Final heartbeat with summary
        if (!opts.dryRun && !summary.guardSkipped) {
          bb.sendHeartbeat({
            sessionId: agent.session_id,
            progress: `${summary.checked} checked, ${summary.alerts} alerts, ${summary.skipped} skipped`,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exitCode = 1;
      } finally {
        bb.deregisterAgent(agent.session_id);
      }
    });
}

function statusIcon(status: string): string {
  switch (status) {
    case 'ok': return '✓';
    case 'alert': return '⚠';
    case 'error': return '✗';
    default: return '?';
  }
}

function printSummary(
  results: CheckResult[],
  dueResults: DueCheckResult[],
  summary: { checked: number; alerts: number; errors: number; skipped: number; disabled: number; timestamp: string }
): void {
  console.log(`ivy-heartbeat check — ${summary.timestamp}`);

  for (const result of results) {
    console.log(`  ${statusIcon(result.status)} ${result.item.name}: ${result.status} (${result.summary})`);
  }

  // Show skipped items
  for (const due of dueResults) {
    if (!due.isDue) {
      console.log(`  ─ ${due.item.name}: skipped (${due.reason})`);
    }
  }

  console.log('');
  const parts: string[] = [];
  if (summary.checked > 0) parts.push(`${summary.checked} checked`);
  if (summary.alerts > 0) parts.push(`${summary.alerts} alert${summary.alerts > 1 ? 's' : ''}`);
  if (summary.errors > 0) parts.push(`${summary.errors} error${summary.errors > 1 ? 's' : ''}`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (summary.disabled > 0) parts.push(`${summary.disabled} disabled`);

  if (parts.length === 0) {
    console.log('No checklist items found.');
  } else {
    console.log(parts.join(', '));
  }
}

function printSkipped(summary: CheckSummary): void {
  const enabled = summary.guardResult?.enabledCount ?? 0;
  console.log(`ivy-heartbeat check — skipped (no items due, ${enabled} enabled)`);
}

function printDryRun(dueResults: DueCheckResult[], disabledCount: number): void {
  console.log('ivy-heartbeat check --dry-run');

  let wouldRun = 0;
  let notDue = 0;

  for (const due of dueResults) {
    if (due.isDue) {
      console.log(`  → ${due.item.name}: DUE (${due.reason})`);
      wouldRun++;
    } else {
      console.log(`  → ${due.item.name}: NOT DUE (${due.reason})`);
      notDue++;
    }
  }

  console.log('');
  const parts: string[] = [];
  if (wouldRun > 0) parts.push(`${wouldRun} would run`);
  if (notDue > 0) parts.push(`${notDue} not due`);
  if (disabledCount > 0) parts.push(`${disabledCount} disabled`);

  if (parts.length === 0) {
    console.log('No checklist items found.');
  } else {
    console.log(parts.join(', '));
  }
}
