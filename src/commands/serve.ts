import { Command } from 'commander';
import type { CliContext } from '../cli.ts';
import { startServer } from '../serve/server.ts';

export function registerServeCommand(
  parent: Command,
  getContext: () => CliContext
): void {
  parent
    .command('serve')
    .description('Start web dashboard server')
    .option('--port <n>', 'Port to listen on', '7878')
    .action((opts) => {
      try {
        const ctx = getContext();
        const port = parseInt(opts.port, 10);

        const server = startServer(ctx.bb, { port });

        console.log(`ivy-heartbeat dashboard running at http://localhost:${server.port}`);
        console.log('Press Ctrl+C to stop.');

        // Keep process alive — Bun.serve() holds the event loop in dev mode,
        // but compiled binaries exit after commander's action returns.
        const keepAlive = setInterval(() => {}, 1 << 30);

        process.on('SIGINT', () => {
          clearInterval(keepAlive);
          server.stop();
          ctx.bb.close();
          process.exit(0);
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });
}
