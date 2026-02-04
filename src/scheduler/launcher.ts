import type { LaunchOptions, LaunchResult, SessionLauncher } from './types.ts';

/**
 * Default launcher: spawns `claude --print` in the project directory.
 * The --print flag runs Claude non-interactively and prints the result.
 */
async function defaultLauncher(opts: LaunchOptions): Promise<LaunchResult> {
  const proc = Bun.spawn(
    ['claude', '--print', '--verbose', opts.prompt],
    {
      cwd: opts.workDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env },
    }
  );

  // Set up timeout
  const timeoutId = setTimeout(() => {
    proc.kill('SIGTERM');
  }, opts.timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timeoutId);

  return { exitCode, stdout, stderr };
}

let currentLauncher: SessionLauncher = defaultLauncher;

/**
 * Get the current session launcher.
 */
export function getLauncher(): SessionLauncher {
  return currentLauncher;
}

/**
 * Override the session launcher (for testing).
 */
export function setLauncher(launcher: SessionLauncher): void {
  currentLauncher = launcher;
}

/**
 * Reset to the default launcher.
 */
export function resetLauncher(): void {
  currentLauncher = defaultLauncher;
}
