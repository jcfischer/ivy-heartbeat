import { Command } from 'commander';
import type { CliContext } from '../cli.ts';
import { dispatch } from '../scheduler/scheduler.ts';
import { formatJson } from 'ivy-blackboard/src/output';
import type { DispatchResult } from '../scheduler/types.ts';

export function registerDispatchCommand(
  parent: Command,
  getContext: () => CliContext
): void {
  parent
    .command('dispatch')
    .description('Dispatch available work items to Claude Code sessions')
    .option('--max-concurrent <n>', 'Max concurrent agent sessions', '1')
    .option('--max-items <n>', 'Max items to process per run', '1')
    .option('--priority <priority>', 'Filter by priority (e.g. P1 or P1,P2)')
    .option('--project <project>', 'Filter by project')
    .option('--dry-run', 'Show what would be dispatched without executing')
    .option('--timeout <minutes>', 'Timeout per work item in minutes', '60')
    .action(async (opts) => {
      const ctx = getContext();

      const result = await dispatch(ctx.bb, {
        maxConcurrent: parseInt(opts.maxConcurrent, 10),
        maxItems: parseInt(opts.maxItems, 10),
        priority: opts.priority,
        project: opts.project,
        dryRun: !!opts.dryRun,
        timeout: parseInt(opts.timeout, 10),
      });

      if (ctx.json) {
        console.log(formatJson(result));
      } else if (opts.dryRun) {
        printDryRun(result);
      } else {
        printResult(result);
      }
    });
}

function printDryRun(result: DispatchResult): void {
  console.log('ivy-heartbeat dispatch --dry-run');

  if (result.dispatched.length === 0 && result.skipped.length === 0) {
    console.log('  No available work items.');
    return;
  }

  for (const d of result.dispatched) {
    console.log(`  → ${d.itemId}: WOULD DISPATCH to ${d.projectId}`);
    console.log(`    "${d.title}"`);
  }

  for (const s of result.skipped) {
    console.log(`  ─ ${s.itemId}: SKIP (${s.reason})`);
  }

  console.log('');
  const parts: string[] = [];
  if (result.dispatched.length > 0) parts.push(`${result.dispatched.length} would dispatch`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
  console.log(parts.join(', '));
}

function printResult(result: DispatchResult): void {
  console.log(`ivy-heartbeat dispatch — ${result.timestamp}`);

  if (result.dispatched.length === 0 && result.skipped.length === 0 && result.errors.length === 0) {
    console.log('  No available work items.');
    return;
  }

  for (const d of result.dispatched) {
    const status = d.completed ? '✓' : '✗';
    const duration = d.durationMs > 0 ? ` (${Math.round(d.durationMs / 1000)}s)` : '';
    console.log(`  ${status} ${d.itemId}: ${d.completed ? 'completed' : 'failed'}${duration}`);
    console.log(`    "${d.title}" in ${d.projectId}`);
  }

  for (const e of result.errors) {
    console.log(`  ✗ ${e.itemId}: error — ${e.error}`);
  }

  for (const s of result.skipped) {
    console.log(`  ─ ${s.itemId}: skipped (${s.reason})`);
  }

  console.log('');
  const parts: string[] = [];
  if (result.dispatched.length > 0) parts.push(`${result.dispatched.length} dispatched`);
  if (result.errors.length > 0) parts.push(`${result.errors.length} errors`);
  if (result.skipped.length > 0) parts.push(`${result.skipped.length} skipped`);
  console.log(parts.join(', '));
}
