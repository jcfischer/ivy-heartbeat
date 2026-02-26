import { join } from 'node:path';

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the specflow CLI with the given arguments.
 * Uses SPECFLOW_BIN env var or ~/bin/specflow as the binary.
 */
export async function runSpecflowCli(
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv?: Record<string, string | undefined>,
): Promise<CliResult> {
  const specflowBin = process.env.SPECFLOW_BIN ?? join(process.env.HOME ?? '', 'bin', 'specflow');

  const proc = Bun.spawn([specflowBin, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CLAUDECODE: undefined, ...extraEnv },
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill('SIGTERM');
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (killed) {
    return { exitCode: -1, stdout, stderr: 'specflow timed out (SIGTERM)' };
  }

  return { exitCode, stdout, stderr };
}

/**
 * Parse an eval score from specflow eval JSON output.
 * Returns a 0-100 score, or 0 if parsing fails.
 */
export function parseEvalScore(stdout: string): number {
  try {
    const parsed = JSON.parse(stdout);
    const testResult = parsed.results?.[0];
    const raw = testResult?.score ?? parsed.score ?? parsed.percentage ?? 0;
    // Normalize 0.0-1.0 → 0-100
    return raw <= 1 ? Math.round(raw * 100) : raw;
  } catch {
    return 0;
  }
}
