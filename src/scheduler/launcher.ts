import { mkdirSync, appendFileSync } from 'node:fs';
import type { LaunchOptions, LaunchResult, SessionLauncher } from './types.ts';

/**
 * Resolve the log directory for dispatch agent logs.
 */
export function resolveLogDir(): string {
  if (process.env.IVY_LOG_DIR) return process.env.IVY_LOG_DIR;
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
 * Summarize a tool_use content block into a concise log line.
 */
function formatToolUse(block: any): string {
  const name = block.name ?? 'unknown';
  const input = block.input ?? {};
  switch (name) {
    case 'Bash': return `[tool] Bash: ${(input.command ?? '').slice(0, 200)}`;
    case 'Read': return `[tool] Read: ${input.file_path ?? ''}`;
    case 'Write': return `[tool] Write: ${input.file_path ?? ''}`;
    case 'Edit': return `[tool] Edit: ${input.file_path ?? ''}`;
    case 'Glob': return `[tool] Glob: ${input.pattern ?? ''}`;
    case 'Grep': return `[tool] Grep: ${input.pattern ?? ''}`;
    case 'Task': return `[tool] Task: ${input.description ?? ''}`;
    case 'TaskCreate': return `[tool] TaskCreate: ${input.subject ?? ''}`;
    case 'TaskUpdate': {
      const status = input.status ? ` → ${input.status}` : '';
      return `[tool] TaskUpdate: #${input.taskId ?? '?'}${status}`;
    }
    case 'TaskList': return '[tool] TaskList';
    case 'TaskOutput': return `[tool] TaskOutput: task=${input.task_id ?? '?'}`;
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      const summary = todos.map((t: any) => `${t.status === 'completed' ? '✓' : '○'} ${(t.content ?? '').slice(0, 60)}`).join(', ');
      return `[tool] TodoWrite: ${summary || '(empty)'}`;
    }
    case 'WebFetch': return `[tool] WebFetch: ${input.url ?? ''}`;
    case 'WebSearch': return `[tool] WebSearch: ${input.query ?? ''}`;
    case 'Skill': return `[tool] Skill: ${input.skill ?? ''}`;
    case 'NotebookEdit': return `[tool] NotebookEdit: ${input.notebook_path ?? ''}`;
    default: return `[tool] ${name}`;
  }
}

/**
 * Format a stream-json message into human-readable log lines.
 * Returns null for messages that shouldn't be logged.
 *
 * Stream-json message types:
 * - system: {subtype: "init"|"hook_started"|"hook_response", ...}
 * - assistant: {message: {content: [{type:"text",text:...}, {type:"tool_use",name:...,input:...}]}}
 * - tool_result: {content: [{type:"text",text:...}], is_error?: boolean}
 * - result: {subtype: "success"|"error", result?: string}
 */
function formatStreamMessage(msg: any): string | null {
  switch (msg.type) {
    case 'assistant': {
      const content = msg.message?.content ?? [];
      const parts: string[] = [];

      for (const block of content) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text);
        } else if (block.type === 'tool_use') {
          parts.push(formatToolUse(block));
        }
      }

      return parts.length > 0 ? parts.join('\n') : null;
    }
    case 'tool_result': {
      // Log errors; skip successful results (too verbose)
      if (msg.is_error) {
        const text = Array.isArray(msg.content)
          ? msg.content.map((c: any) => c.text ?? '').join('')
          : String(msg.content ?? 'unknown error');
        return `[tool:error] ${text.slice(0, 300)}`;
      }
      return null;
    }
    case 'result': {
      const text = msg.result ?? '';
      if (!text) return null;
      return `\n--- RESULT ---\n${text}`;
    }
    case 'system': {
      // Skip hook lifecycle noise; only log init
      if (msg.subtype === 'init') return '[system] Session initialized';
      return null;
    }
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

  const args = ['claude', '--print', '--verbose', '--output-format', 'stream-json'];
  if (opts.disableMcp) {
    args.push('--strict-mcp-config');
  }
  args.push(opts.prompt);

  const env: Record<string, string | undefined> = {
    ...process.env,
    CLAUDECODE: undefined,
    // When OAuth token is available, suppress ANTHROPIC_API_KEY to force OAuth auth.
    // The `claude` CLI is Bun-compiled with --compile-autoload-dotenv, so it loads
    // .env from its CWD. Target projects may have a depleted ANTHROPIC_API_KEY in
    // their .env. We set it to empty string "" which:
    // 1. Prevents Bun's .env loading from overriding (key exists in env)
    // 2. Is falsy, so Claude Code skips it and falls through to CLAUDE_CODE_OAUTH_TOKEN
    ...(process.env.CLAUDE_CODE_OAUTH_TOKEN ? { ANTHROPIC_API_KEY: '' } : {}),
  };

  const proc = Bun.spawn(args, {
    cwd: opts.workDir,
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });

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
