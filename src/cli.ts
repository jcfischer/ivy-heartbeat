#!/usr/bin/env bun

import { Command } from 'commander';
import { Blackboard } from './blackboard.ts';
import { registerAgentCommands } from './commands/agent.ts';
import { registerObserveCommand } from './commands/observe.ts';
import { registerCheckCommand } from './commands/check.ts';
import { registerScheduleCommand } from './commands/schedule.ts';

export interface CliContext {
  bb: Blackboard;
  json: boolean;
}

const program = new Command()
  .name('ivy-heartbeat')
  .version('0.1.0')
  .description('Proactive heartbeat monitoring for PAI')
  .option('-j, --json', 'Output as JSON', false)
  .option('--db <path>', 'Database path (overrides all resolution)');

let cached: CliContext | null = null;

function getContext(): CliContext {
  if (cached) return cached;

  const opts = program.opts();
  const bb = new Blackboard(opts.db);

  cached = { bb, json: opts.json };

  process.on('exit', () => {
    if (cached) {
      cached.bb.close();
      cached = null;
    }
  });

  return cached;
}

registerAgentCommands(program, getContext);
registerObserveCommand(program, getContext);
registerCheckCommand(program, getContext);
registerScheduleCommand(program, getContext);

program.parse();
