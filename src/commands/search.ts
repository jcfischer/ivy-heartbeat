import { Command } from 'commander';
import type { CliContext } from '../cli.ts';
import {
  formatJson,
  formatTable,
  formatRelativeTime,
} from 'ivy-blackboard/src/output';

export function registerSearchCommand(
  parent: Command,
  getContext: () => CliContext
): void {
  parent
    .command('search <query>')
    .description('Full-text search across events')
    .option('--limit <n>', 'Max results', '20')
    .option('--since <iso>', 'Only events after this ISO timestamp')
    .action((query: string, opts) => {
      try {
        const ctx = getContext();
        const limit = parseInt(opts.limit, 10);

        const results = ctx.bb.eventQueries.search(query, {
          limit,
          since: opts.since,
        });

        if (ctx.json) {
          console.log(formatJson(results));
          return;
        }

        if (results.length === 0) {
          console.log(`No events matching "${query}".`);
          return;
        }

        const headers = ['RANK', 'TIME', 'TYPE', 'SUMMARY'];
        const rows = results.map((r) => [
          r.rank.toFixed(2),
          formatRelativeTime(r.event.timestamp),
          r.event.event_type,
          truncate(r.event.summary, 60),
        ]);

        console.log(`${results.length} result(s) for "${query}":\n`);
        console.log(formatTable(headers, rows));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}
