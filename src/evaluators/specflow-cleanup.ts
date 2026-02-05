import { join } from 'node:path';
import { readdirSync, existsSync, statSync } from 'node:fs';
import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';
import type { Blackboard } from '../blackboard.ts';
import { removeWorktree } from '../scheduler/worktree.ts';

// ─── Injectable blackboard accessor (for testing) ─────────────────────

export type CleanupBlackboardAccessor = {
  listWorkItems(opts?: { all?: boolean }): Array<{ metadata: string | null; updated_at?: string }>;
  appendEvent(opts: {
    summary: string;
    metadata?: Record<string, unknown>;
  }): void;
};

let bbAccessor: CleanupBlackboardAccessor | null = null;

export function setCleanupBlackboard(accessor: CleanupBlackboardAccessor): void {
  bbAccessor = accessor;
}

export function resetCleanupBlackboard(): void {
  bbAccessor = null;
}

// ─── Injectable worktree scanner (for testing) ────────────────────────

export type WorktreeScanner = () => Array<{
  path: string;
  projectPath: string;
  featureId: string;
}>;

let scanner: WorktreeScanner = defaultScanner;

function defaultScanner(): Array<{
  path: string;
  projectPath: string;
  featureId: string;
}> {
  const baseDir = process.env.IVY_WORKTREE_DIR ?? join(process.env.HOME ?? '/tmp', '.pai', 'worktrees');
  const results: Array<{ path: string; projectPath: string; featureId: string }> = [];

  if (!existsSync(baseDir)) return results;

  try {
    const projectDirs = readdirSync(baseDir, { withFileTypes: true });
    for (const projDir of projectDirs) {
      if (!projDir.isDirectory()) continue;
      const projPath = join(baseDir, projDir.name);
      const entries = readdirSync(projPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith('specflow-')) continue;
        const featureId = entry.name.replace('specflow-', '').toUpperCase();
        results.push({
          path: join(projPath, entry.name),
          projectPath: projPath,
          featureId,
        });
      }
    }
  } catch {
    // Scan failed
  }

  return results;
}

export function setWorktreeScanner(fn: WorktreeScanner): void {
  scanner = fn;
}

export function resetWorktreeScanner(): void {
  scanner = defaultScanner;
}

// ─── Injectable worktree remover (for testing) ────────────────────────

export type WorktreeRemover = (projectPath: string, worktreePath: string) => Promise<void>;

let remover: WorktreeRemover = removeWorktree;

export function setWorktreeRemover(fn: WorktreeRemover): void {
  remover = fn;
}

export function resetWorktreeRemover(): void {
  remover = removeWorktree;
}

// ─── Evaluator ────────────────────────────────────────────────────────

interface CleanupConfig {
  staleness_days: number;
}

function parseCleanupConfig(item: ChecklistItem): CleanupConfig {
  return {
    staleness_days: typeof item.config.staleness_days === 'number'
      ? item.config.staleness_days
      : 7,
  };
}

/**
 * Evaluate SpecFlow worktree staleness and clean up stale worktrees.
 */
export async function evaluateSpecFlowCleanup(item: ChecklistItem): Promise<CheckResult> {
  if (!bbAccessor) {
    return {
      item,
      status: 'error',
      summary: `SpecFlow cleanup: ${item.name} — blackboard not configured`,
      details: { error: 'Blackboard accessor not set.' },
    };
  }

  const config = parseCleanupConfig(item);
  const staleThreshold = Date.now() - config.staleness_days * 24 * 60 * 60 * 1000;

  try {
    const worktrees = scanner();

    if (worktrees.length === 0) {
      return {
        item,
        status: 'ok',
        summary: `SpecFlow cleanup: ${item.name} — no specflow worktrees found`,
        details: { cleaned: 0, total: 0 },
      };
    }

    // Check each worktree for activity
    const allItems = bbAccessor.listWorkItems({ all: true });
    let cleaned = 0;
    let failures = 0;

    for (const wt of worktrees) {
      // Find most recent work item activity for this feature
      const lastActivity = findLastActivity(allItems, wt.featureId);

      if (lastActivity && lastActivity > staleThreshold) {
        continue; // Still active
      }

      // Stale — remove
      try {
        await remover(wt.projectPath, wt.path);
        cleaned++;
        bbAccessor.appendEvent({
          summary: `Cleaned stale SpecFlow worktree: ${wt.path} (feature: ${wt.featureId})`,
          metadata: { worktreePath: wt.path, featureId: wt.featureId },
        });
      } catch {
        failures++;
      }
    }

    if (failures > 0) {
      return {
        item,
        status: 'alert',
        summary: `SpecFlow cleanup: ${item.name} — cleaned ${cleaned}, ${failures} failure(s)`,
        details: { cleaned, failures, total: worktrees.length },
      };
    }

    return {
      item,
      status: 'ok',
      summary: `SpecFlow cleanup: ${item.name} — cleaned ${cleaned} of ${worktrees.length} worktree(s)`,
      details: { cleaned, total: worktrees.length },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `SpecFlow cleanup: ${item.name} — error: ${msg}`,
      details: { error: msg },
    };
  }
}

/**
 * Find the most recent activity timestamp for a feature from work items.
 */
function findLastActivity(
  items: Array<{ metadata: string | null; updated_at?: string }>,
  featureId: string
): number | null {
  let latest: number | null = null;

  for (const item of items) {
    if (!item.metadata) continue;
    try {
      const meta = JSON.parse(item.metadata);
      if (meta.specflow_feature_id?.toUpperCase() === featureId.toUpperCase()) {
        const ts = item.updated_at ? new Date(item.updated_at).getTime() : 0;
        if (ts > 0 && (latest === null || ts > latest)) {
          latest = ts;
        }
      }
    } catch {
      continue;
    }
  }

  return latest;
}
