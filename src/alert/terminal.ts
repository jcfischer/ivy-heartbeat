import type { CheckResult } from '../check/types.ts';

/**
 * Display a macOS notification via osascript.
 * Returns true on success, false on failure.
 */
export async function notifyTerminal(result: CheckResult): Promise<boolean> {
  const title = 'Ivy Heartbeat';
  const subtitle = result.status;
  const message = `${result.item.name}: ${result.summary}`;

  // Escape double quotes for AppleScript
  const escaped = message.replace(/"/g, '\\"');

  try {
    const proc = Bun.spawn([
      'osascript',
      '-e',
      `display notification "${escaped}" with title "${title}" subtitle "${subtitle}"`,
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}
