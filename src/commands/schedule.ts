import { Command } from 'commander';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import type { CliContext } from '../cli.ts';
import { formatJson } from 'ivy-blackboard/src/output';
import {
  generatePlist,
  isCompiledBinary,
  resolveBunPath,
  resolveCliPath,
  resolveLogDir,
  resolvePlistPath,
  parseIntervalFromPlist,
  DEFAULT_INTERVAL_MINUTES,
} from '../schedule/plist.ts';
import { loadPlist, unloadPlist, isLoaded } from '../schedule/launchctl.ts';

export function registerScheduleCommand(
  parent: Command,
  getContext: () => CliContext
): void {
  const schedule = parent
    .command('schedule')
    .description('Manage heartbeat scheduling via launchd');

  schedule
    .command('install')
    .description('Install launchd plist for periodic heartbeat checks')
    .option('--interval <minutes>', 'Check interval in minutes', String(DEFAULT_INTERVAL_MINUTES))
    .option('--dry-run', 'Print plist XML without installing')
    .action(async (opts) => {
      const ctx = getContext();
      const interval = parseInt(opts.interval, 10);
      if (isNaN(interval) || interval < 1) {
        console.error('Error: interval must be a positive number of minutes');
        process.exitCode = 1;
        return;
      }

      const compiled = isCompiledBinary();
      let binaryPath: string;
      let scriptPath: string | undefined;

      if (compiled) {
        // Compiled binary: use it directly
        binaryPath = resolveCliPath(); // resolves process.argv[0]
      } else {
        // Development: use bun + cli.ts
        try {
          binaryPath = await resolveBunPath();
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Error: ${msg}`);
          process.exitCode = 1;
          return;
        }
        scriptPath = resolveCliPath();
      }

      const logDir = resolveLogDir();
      const plistPath = resolvePlistPath();

      const xml = generatePlist({
        binaryPath,
        scriptPath,
        intervalSeconds: interval * 60,
        logDir,
      });

      if (opts.dryRun) {
        if (ctx.json) {
          console.log(formatJson({
            dryRun: true,
            interval,
            binaryPath,
            scriptPath,
            logDir,
            plistPath,
            xml,
          }));
        } else {
          console.log(xml);
        }
        return;
      }

      // Unload existing if present
      if (existsSync(plistPath)) {
        try {
          await unloadPlist(plistPath);
        } catch {
          // Ignore unload errors on reinstall
        }
      }

      writeFileSync(plistPath, xml, 'utf-8');
      await loadPlist(plistPath);

      if (ctx.json) {
        console.log(formatJson({
          installed: true,
          interval,
          plistPath,
          logDir,
        }));
      } else {
        console.log('ivy-heartbeat schedule installed');
        console.log(`  Interval: ${interval} minutes`);
        console.log(`  Plist:    ${plistPath}`);
        console.log(`  Logs:     ${logDir}/`);
      }
    });

  schedule
    .command('uninstall')
    .description('Remove launchd plist and stop periodic checks')
    .action(async () => {
      const ctx = getContext();
      const plistPath = resolvePlistPath();

      if (!existsSync(plistPath)) {
        if (ctx.json) {
          console.log(formatJson({ installed: false, message: 'Not installed' }));
        } else {
          console.log('Not installed.');
        }
        return;
      }

      await unloadPlist(plistPath);
      unlinkSync(plistPath);

      if (ctx.json) {
        console.log(formatJson({ installed: false, uninstalled: true }));
      } else {
        console.log('ivy-heartbeat schedule uninstalled');
      }
    });

  schedule
    .command('status')
    .description('Show heartbeat schedule status')
    .action(async () => {
      const ctx = getContext();
      const plistPath = resolvePlistPath();
      const installed = existsSync(plistPath);
      const loaded = installed ? await isLoaded() : false;

      let interval: number | null = null;
      if (installed) {
        const xml = readFileSync(plistPath, 'utf-8');
        interval = parseIntervalFromPlist(xml);
      }

      const logDir = resolveLogDir();

      if (ctx.json) {
        console.log(formatJson({
          installed,
          loaded,
          interval,
          plistPath,
          logDir,
        }));
      } else {
        console.log('ivy-heartbeat schedule');
        if (installed) {
          console.log(`  Status:   ${loaded ? 'installed and loaded' : 'installed (not loaded)'}`);
          if (interval) console.log(`  Interval: ${interval} minutes`);
          console.log(`  Plist:    ${plistPath}`);
          console.log(`  Logs:     ${logDir}/`);
        } else {
          console.log('  Status: not installed');
          console.log("  Run 'ivy-heartbeat schedule install' to start");
        }
      }
    });
}
