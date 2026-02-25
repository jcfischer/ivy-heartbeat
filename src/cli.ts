#!/usr/bin/env bun

// Load .env for compiled binaries (Bun only auto-loads .env in dev mode)
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
for (const dir of [process.cwd(), join(process.env.HOME ?? '', 'work', 'ivy-heartbeat')]) {
  const envPath = join(dir, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = value;
    }
    break;
  }
}

import { Command } from 'commander';
import { Blackboard } from './blackboard.ts';
import { registerAgentCommands } from './commands/agent.ts';
import { registerObserveCommand } from './commands/observe.ts';
import { registerCheckCommand } from './commands/check.ts';
import { registerScheduleCommand } from './commands/schedule.ts';
import { registerSearchCommand } from './commands/search.ts';
import { registerExportCommand } from './commands/export.ts';
import { registerServeCommand } from './commands/serve.ts';
import { registerDispatchCommand } from './commands/dispatch.ts';
import { registerDispatchWorkerCommand } from './commands/dispatch-worker.ts';
import { registerSpecFlowQueueCommand } from './commands/specflow-queue.ts';

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
registerSearchCommand(program, getContext);
registerExportCommand(program, getContext);
registerServeCommand(program, getContext);
registerDispatchCommand(program, getContext);
registerDispatchWorkerCommand(program, getContext);
registerSpecFlowQueueCommand(program, getContext);

program.parse();
