import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';

interface LadderBridgeConfig {
  ladderDir: string;
}

/**
 * Parse ladder bridge config from a checklist item's config fields.
 */
function parseLadderBridgeConfig(item: ChecklistItem): LadderBridgeConfig {
  const ladderDir =
    (item.config.ladder_dir as string) ??
    join(process.env.HOME ?? '/tmp', 'work', 'sandbox', 'Ladder');

  return { ladderDir };
}

// ─── Injectable bridge executor (for testing) ────────────────────────

export type BridgeExecutor = (ladderDir: string) => Promise<{
  success: boolean;
  created: number;
  skipped: number;
  output: string;
}>;

let bridgeExecutor: BridgeExecutor = defaultBridgeExecutor;

async function defaultBridgeExecutor(ladderDir: string): Promise<{
  success: boolean;
  created: number;
  skipped: number;
  output: string;
}> {
  const scriptPath = join(ladderDir, 'Tools', 'pai-bridge.ts');

  if (!existsSync(scriptPath)) {
    return {
      success: false,
      created: 0,
      skipped: 0,
      output: `Script not found: ${scriptPath}`,
    };
  }

  try {
    const proc = Bun.spawn(['bun', 'run', scriptPath, 'all'], {
      cwd: ladderDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return {
        success: false,
        created: 0,
        skipped: 0,
        output: stderr || output,
      };
    }

    // Parse output for "X created, Y skipped"
    // Example: "Summary: 0 created, 99 skipped (already imported)"
    const createdMatch = output.match(/(\d+)\s+created/);
    const skippedMatch = output.match(/(\d+)\s+skipped/);

    const created = createdMatch ? parseInt(createdMatch[1], 10) : 0;
    const skipped = skippedMatch ? parseInt(skippedMatch[1], 10) : 0;

    return {
      success: true,
      created,
      skipped,
      output,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      created: 0,
      skipped: 0,
      output: `Error executing bridge: ${msg}`,
    };
  }
}

/**
 * Override the bridge executor (for testing).
 */
export function setBridgeExecutor(executor: BridgeExecutor): void {
  bridgeExecutor = executor;
}

/**
 * Reset to default bridge executor.
 */
export function resetBridgeExecutor(): void {
  bridgeExecutor = defaultBridgeExecutor;
}

/**
 * Evaluate ladder bridge: import new PAI signals into Ladder pipeline.
 */
export async function evaluateLadderBridge(item: ChecklistItem): Promise<CheckResult> {
  const config = parseLadderBridgeConfig(item);

  if (!existsSync(config.ladderDir)) {
    return {
      item,
      status: 'error',
      summary: `Ladder bridge: ${item.name} — Ladder directory not found: ${config.ladderDir}`,
      details: { configured: true, error: `Directory not found: ${config.ladderDir}` },
    };
  }

  try {
    const result = await bridgeExecutor(config.ladderDir);

    if (!result.success) {
      return {
        item,
        status: 'error',
        summary: `Ladder bridge: ${item.name} — script failed`,
        details: {
          error: result.output,
          ladderDir: config.ladderDir,
        },
      };
    }

    if (result.created > 0) {
      return {
        item,
        status: 'alert',
        summary: `Ladder bridge: ${item.name} — ${result.created} new source(s) imported`,
        details: {
          created: result.created,
          skipped: result.skipped,
          ladderDir: config.ladderDir,
        },
      };
    }

    return {
      item,
      status: 'ok',
      summary: `Ladder bridge: ${item.name} — no new sources (${result.skipped} already imported)`,
      details: {
        created: 0,
        skipped: result.skipped,
        ladderDir: config.ladderDir,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `Ladder bridge: ${item.name} — error: ${msg}`,
      details: { error: msg, ladderDir: config.ladderDir },
    };
  }
}
