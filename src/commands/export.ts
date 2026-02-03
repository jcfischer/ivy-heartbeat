import { Command } from 'commander';
import type { CliContext } from '../cli.ts';
import { collectDailyEvents, generateDailyLog } from '../export/daily-log.ts';
import { formatJson } from 'ivy-blackboard/src/output';

export function registerExportCommand(
  parent: Command,
  getContext: () => CliContext
): void {
  parent
    .command('export')
    .description('Export daily log from events')
    .option('--date <YYYY-MM-DD>', 'Date to export (defaults to today)')
    .action((opts) => {
      try {
        const ctx = getContext();
        const date = opts.date ?? new Date().toISOString().split('T')[0];

        const data = collectDailyEvents(ctx.bb, date);

        if (ctx.json) {
          console.log(formatJson(data));
          return;
        }

        const markdown = generateDailyLog(data);
        console.log(markdown);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });
}
