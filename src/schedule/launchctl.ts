import { PLIST_LABEL } from './plist.ts';

/**
 * Load a plist into launchd.
 */
export async function loadPlist(plistPath: string): Promise<void> {
  const proc = Bun.spawn(['launchctl', 'load', plistPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  if (proc.exitCode !== 0 && !stderr.includes('already loaded')) {
    throw new Error(`launchctl load failed: ${stderr.trim()}`);
  }
}

/**
 * Unload a plist from launchd.
 */
export async function unloadPlist(plistPath: string): Promise<void> {
  const proc = Bun.spawn(['launchctl', 'unload', plistPath], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  // Ignore errors if not loaded or not found
  if (proc.exitCode !== 0 && !stderr.includes('Could not find')) {
    throw new Error(`launchctl unload failed: ${stderr.trim()}`);
  }
}

/**
 * Check if the agent is currently loaded in launchd.
 */
export async function isLoaded(): Promise<boolean> {
  const proc = Bun.spawn(['launchctl', 'list'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  return stdout.includes(PLIST_LABEL);
}
