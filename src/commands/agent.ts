import { Command } from 'commander';
import type { CliContext } from '../cli.ts';
import { listAgents } from 'ivy-blackboard/src/agent';
import {
  formatJson,
  formatTable,
  formatRelativeTime,
} from 'ivy-blackboard/src/output';

export function registerAgentCommands(
  parent: Command,
  getContext: () => CliContext
): void {
  const agent = parent
    .command('agent')
    .description('Manage agent sessions');

  agent
    .command('register')
    .description('Register a new agent session')
    .requiredOption('--name <name>', 'Agent display name')
    .option('--project <project>', 'Project context')
    .option('--work <work>', 'Current work description')
    .option('--parent <sessionId>', 'Parent session ID (for delegates)')
    .action((opts) => {
      try {
        const ctx = getContext();
        const result = ctx.bb.registerAgent({
          name: opts.name,
          project: opts.project,
          work: opts.work,
          parentId: opts.parent,
        });

        if (ctx.json) {
          console.log(formatJson(result));
        } else {
          console.log(result.session_id);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });

  agent
    .command('heartbeat')
    .description('Send agent heartbeat')
    .requiredOption('--session <id>', 'Session ID')
    .option('--progress <text>', 'Progress note')
    .action((opts) => {
      try {
        const ctx = getContext();
        const result = ctx.bb.sendHeartbeat({
          sessionId: opts.session,
          progress: opts.progress,
        });

        if (ctx.json) {
          console.log(formatJson(result));
        } else {
          console.log(`Heartbeat sent for ${result.session_id}`);
          if (result.progress) console.log(`Progress: ${result.progress}`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });

  agent
    .command('deregister')
    .description('Deregister an agent session')
    .requiredOption('--session <id>', 'Session ID to deregister')
    .action((opts) => {
      try {
        const ctx = getContext();
        const result = ctx.bb.deregisterAgent(opts.session);

        if (ctx.json) {
          console.log(formatJson(result));
        } else {
          console.log(`Deregistered ${result.agent_name} (${result.session_id})`);
          console.log(`Released ${result.released_count} work item(s)`);
          const mins = Math.floor(result.duration_seconds / 60);
          const secs = result.duration_seconds % 60;
          console.log(`Duration: ${mins > 0 ? `${mins}m ` : ''}${secs}s`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });

  agent
    .command('list')
    .description('List agent sessions')
    .option('--all', 'Include completed and stale agents')
    .option('--status <status>', 'Filter by status (comma-separated)')
    .action((opts) => {
      try {
        const ctx = getContext();
        const agents = listAgents(ctx.bb.db, {
          all: opts.all,
          status: opts.status,
        });

        if (ctx.json) {
          console.log(formatJson(agents));
        } else if (agents.length === 0) {
          console.log('No active agents.');
        } else {
          const headers = ['SESSION', 'NAME', 'PROJECT', 'STATUS', 'LAST SEEN', 'PID'];
          const rows = agents.map((a) => [
            a.session_id.slice(0, 12),
            a.agent_name,
            a.project ?? '-',
            a.status,
            formatRelativeTime(a.last_seen_at),
            String(a.pid ?? '-'),
          ]);
          console.log(formatTable(headers, rows));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });
}
