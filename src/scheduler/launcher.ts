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
 * Format a stream-json message into a human-readable log line.
 * Returns null for messages that shouldn't be logged.
 */
function formatStreamMessage(msg: any): string | null {
  switch (msg.type) {
    case 'assistant': {
      // Assistant text message
      const text = msg.message?.content
        ?.filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('') ?? '';
      if (!text) return null;
      return text;
    }
    case 'tool_use': {
      const name = msg.tool?.name ?? msg.name ?? 'unknown';
      const input = msg.tool?.input ?? msg.input;
      // Summarize tool invocations concisely
      if (name === 'Bash') {
        const cmd = input?.command ?? '';
        return `[tool] Bash: ${cmd.slice(0, 200)}`;
      }
      if (name === 'Read') {
        return `[tool] Read: ${input?.file_path ?? ''}`;
      }
      if (name === 'Write') {
        return `[tool] Write: ${input?.file_path ?? ''}`;
      }
      if (name === 'Edit') {
        return `[tool] Edit: ${input?.file_path ?? ''}`;
      }
      if (name === 'Glob') {
        return `[tool] Glob: ${input?.pattern ?? ''}`;
      }
      if (name === 'Grep') {
        return `[tool] Grep: ${input?.pattern ?? ''}`;
      }
      if (name === 'Task') {
        return `[tool] Task: ${input?.description ?? ''}`;
      }
      return `[tool] ${name}`;
    }
    case 'tool_result': {
      // Log errors, skip successful results (too verbose)
      if (msg.is_error || msg.error) {
        const errText = msg.content ?? msg.error ?? 'unknown error';
        return `[tool:error] ${String(errText).slice(0, 300)}`;
      }
      return null;
    }
    case 'result': {
      // Final result summary
      const text = msg.result ?? '';
      if (!text) return null;
      return `\n--- RESULT ---\n${text}`;
    }
    case 'system':
      return `[system] ${msg.message ?? ''}`;
    default:
      return null;
  }
}

/**
 * Stream stdout from `claude --print --output-format stream-json`,
 * parse each JSON message, and write human-readable lines to the log file.
 * Returns the full raw output for the LaunchResult.
 */
async function streamJsonToLog(
  stream: ReadableStream<Uint8Array>,
  logPath: string
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    chunks.push(text);
    buffer += text;

    // Process complete lines (each stream-json message is one line)
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? ''; // Keep incomplete last line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        const formatted = formatStreamMessage(msg);
        if (formatted) {
          appendFileSync(logPath, formatted + '\n');
        }
      } catch {
        // Not valid JSON — write raw line
        if (line.trim().length > 0) {
          appendFileSync(logPath, line + '\n');
        }
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim()) {
    try {
      const msg = JSON.parse(buffer);
      const formatted = formatStreamMessage(msg);
      if (formatted) appendFileSync(logPath, formatted + '\n');
    } catch {
      appendFileSync(logPath, buffer + '\n');
    }
  }

  return chunks.join('');
}

/**
 * Stream stderr lines to the log file with a prefix.
 */
async function streamStderrToLog(
  stream: ReadableStream<Uint8Array>,
  logPath: string
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const text = decoder.decode(value, { stream: true });
    chunks.push(text);

    try {
      const lines = text.split('\n');
      for (const line of lines) {
        if (line.length > 0) {
          appendFileSync(logPath, `[stderr] ${line}\n`);
        }
      }
    } catch {}
  }

  return chunks.join('');
}

/**
 * Default launcher: spawns `claude --print --output-format stream-json`
 * in the project directory. Parses streaming JSON into human-readable
 * log lines written incrementally to a log file.
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
    ['claude', '--print', '--verbose', '--output-format', 'stream-json', opts.prompt],
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

  // Stream stdout (JSON) and stderr to log file in parallel
  const [stdout, stderr] = await Promise.all([
    streamJsonToLog(proc.stdout as ReadableStream<Uint8Array>, logPath),
    streamStderrToLog(proc.stderr as ReadableStream<Uint8Array>, logPath),
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
