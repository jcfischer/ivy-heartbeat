import { mkdirSync, appendFileSync } from 'node:fs';
import type { LaunchOptions, LaunchResult, SessionLauncher } from './types.ts';

/**
 * Resolve the log directory for dispatch agent logs.
 */
export function resolveLogDir(): string {
  const home = process.env.HOME ?? '/tmp';
  return `${home}/.pai/blackboard/logs`;
}

/**
 * Get the log file path for a given session.
 */
export function logPathForSession(sessionId: string): string {
  return `${resolveLogDir()}/${sessionId}.log`;
}

/**
 * Stream a ReadableStream to both a string accumulator and a log file.
 * Writes to the file incrementally as chunks arrive.
 */
async function streamToFileAndString(
  stream: ReadableStream<Uint8Array>,
  logPath: string,
  prefix: string
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    chunks.push(text);

    // Append to log file incrementally
    try {
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.length > 0) {
          appendFileSync(logPath, `${prefix}${line}\n`);
        }
      }
    } catch {
      // Best effort — don't fail the launch if logging fails
    }
  }

  return chunks.join('');
}

/**
 * Default launcher: spawns `claude --print` in the project directory.
 * Streams stdout/stderr to a log file in real-time.
 */
async function defaultLauncher(opts: LaunchOptions): Promise<LaunchResult> {
  // Ensure log directory exists
  const logDir = resolveLogDir();
  mkdirSync(logDir, { recursive: true });

  const logPath = logPathForSession(opts.sessionId);
  const startTime = Date.now();

  // Write header to log file
  appendFileSync(logPath, [
    `=== Dispatch Session: ${opts.sessionId} ===`,
    `Work Dir: ${opts.workDir}`,
    `Started: ${new Date(startTime).toISOString()}`,
    `Timeout: ${opts.timeoutMs / 1000}s`,
    `---`,
    `Prompt: ${opts.prompt}`,
    `===`,
    '',
  ].join('\n'));

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
    appendFileSync(logPath, `\n=== TIMEOUT (${opts.timeoutMs / 1000}s) — sending SIGTERM ===\n`);
    proc.kill('SIGTERM');
  }, opts.timeoutMs);

  // Stream stdout and stderr to log file in parallel
  const [stdout, stderr] = await Promise.all([
    streamToFileAndString(proc.stdout as ReadableStream<Uint8Array>, logPath, ''),
    streamToFileAndString(proc.stderr as ReadableStream<Uint8Array>, logPath, '[stderr] '),
  ]);

  const exitCode = await proc.exited;
  clearTimeout(timeoutId);

  // Write footer
  const durationSec = Math.round((Date.now() - startTime) / 1000);
  appendFileSync(logPath, `\n=== Exit Code: ${exitCode} | Duration: ${durationSec}s ===\n`);

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
