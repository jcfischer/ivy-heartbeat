import { Command } from 'commander';
import type { CliContext } from '../cli.ts';
import {
  formatJson,
  formatTable,
  formatRelativeTime,
} from 'ivy-blackboard/src/output';

export function registerObserveCommand(
  parent: Command,
  getContext: () => CliContext
): void {
  parent
    .command('observe')
    .description('Query events and heartbeats')
    .option('--events', 'Show events')
    .option('--heartbeats', 'Show heartbeats')
    .option('--type <type>', 'Filter events by type')
    .option('--session <id>', 'Filter heartbeats by session ID')
    .option('--limit <n>', 'Max results', '20')
    .action((opts) => {
      try {
        const ctx = getContext();
        const limit = parseInt(opts.limit, 10);

        // Default to showing events if neither flag is given
        const showEvents = opts.events || (!opts.events && !opts.heartbeats);
        const showHeartbeats = opts.heartbeats;

        if (showEvents) {
          const events = opts.type
            ? ctx.bb.eventQueries.getByType(opts.type, { limit })
            : ctx.bb.eventQueries.getRecent(limit);

          if (ctx.json) {
            console.log(formatJson(events));
          } else if (events.length === 0) {
            console.log('No events found.');
          } else {
            const headers = ['TIME', 'TYPE', 'ACTOR', 'SUMMARY'];
            const rows = events.map((e) => [
              formatRelativeTime(e.timestamp),
              e.event_type,
              e.actor_id?.slice(0, 12) ?? '-',
              truncate(e.summary, 60),
            ]);
            console.log(formatTable(headers, rows));
          }
        }

        if (showHeartbeats) {
          const heartbeats = opts.session
            ? ctx.bb.heartbeatQueries.getBySession(opts.session).slice(0, limit)
            : ctx.bb.heartbeatQueries.getRecent(limit);

          if (ctx.json) {
            console.log(formatJson(heartbeats));
          } else if (heartbeats.length === 0) {
            console.log('No heartbeats found.');
          } else {
            const headers = ['TIME', 'SESSION', 'PROGRESS'];
            const rows = heartbeats.map((h) => [
              formatRelativeTime(h.timestamp),
              h.session_id.slice(0, 12),
              truncate(h.progress ?? '-', 60),
            ]);
            console.log(formatTable(headers, rows));
          }
        }
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
