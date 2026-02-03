import { Command } from 'commander';
import type { CliContext } from '../cli.ts';
import {
  formatJson,
  formatTable,
  formatRelativeTime,
} from 'ivy-blackboard/src/output';
import { generateSummary, formatSummaryText } from '../observe/summary.ts';

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
    .option('--credential', 'Show credential access/denial events')
    .option('--session <id>', 'Filter heartbeats by session ID')
    .option('--since <iso>', 'Show events since ISO timestamp')
    .option('--agent <id>', 'Filter events by agent/actor ID')
    .option('--summary', 'Show aggregate dashboard summary')
    .option('--limit <n>', 'Max results', '20')
    .action((opts) => {
      try {
        const ctx = getContext();
        const limit = parseInt(opts.limit, 10);

        // Summary dashboard view
        if (opts.summary) {
          const summary = generateSummary(ctx.bb);
          if (ctx.json) {
            console.log(formatJson(summary));
          } else {
            console.log(formatSummaryText(summary));
          }
          return;
        }

        // Credential events view
        if (opts.credential) {
          const allEvents = ctx.bb.eventQueries.getRecent(limit * 5);
          const credEvents = allEvents.filter((e) => {
            if (!e.metadata) return false;
            const meta = typeof e.metadata === 'string' ? e.metadata : JSON.stringify(e.metadata);
            return meta.includes('"credentialEvent":true') || meta.includes('"credentialEvent": true');
          }).slice(0, limit);

          if (ctx.json) {
            console.log(formatJson(credEvents));
          } else if (credEvents.length === 0) {
            console.log('No credential events found.');
          } else {
            const headers = ['TIME', 'OUTCOME', 'SKILL', 'CREDENTIAL', 'SUMMARY'];
            const rows = credEvents.map((e) => {
              let meta: Record<string, unknown> = {};
              try { meta = JSON.parse(typeof e.metadata === 'string' ? e.metadata : '{}'); } catch {}
              return [
                formatRelativeTime(e.timestamp),
                String(meta.outcome ?? '-'),
                String(meta.skill ?? '-'),
                String(meta.credentialType ?? '-'),
                truncate(e.summary, 50),
              ];
            });
            console.log(formatTable(headers, rows));
          }
          return;
        }

        // Default to showing events if neither flag is given
        const showEvents = opts.events || (!opts.events && !opts.heartbeats);
        const showHeartbeats = opts.heartbeats;

        if (showEvents) {
          let events;
          if (opts.agent) {
            events = ctx.bb.eventQueries.getByActor(opts.agent, {
              limit,
              since: opts.since,
            });
          } else if (opts.since) {
            events = ctx.bb.eventQueries.getSince(opts.since).slice(0, limit);
          } else if (opts.type) {
            events = ctx.bb.eventQueries.getByType(opts.type, { limit });
          } else {
            events = ctx.bb.eventQueries.getRecent(limit);
          }

          if (ctx.json) {
            console.log(formatJson(events));
          } else if (events.length === 0) {
            console.log('No events found.');
          } else {
            if (opts.since) {
              console.log(`${events.length} event(s) since ${opts.since}:\n`);
            }
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
