import { join } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';

/**
 * Find the feature directory in .specify/specs/ by feature ID prefix.
 *
 * Feature directories are named like: f-019-specflow-dispatch-agent
 * This function performs a case-insensitive prefix match on the feature ID.
 *
 * @param specDir - Path to .specify/specs directory
 * @param featureId - Feature ID to search for (case-insensitive prefix match)
 * @returns Full path to feature directory, or null if not found
 */
export function findFeatureDir(specDir: string, featureId: string): string | null {
  try {
    const entries = readdirSync(specDir, { withFileTypes: true });
    const prefix = featureId.toLowerCase();
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix)) {
        return join(specDir, entry.name);
      }
    }
  } catch {
    // specDir doesn't exist or not accessible
  }
  return null;
}

/**
 * Resolve the feature directory with a DB fallback for ID-remapped features.
 *
 * Some features are registered in the blackboard with an ID (e.g. "F-107") that
 * differs from their spec directory name (e.g. "F-103-sync-watch-mode"). The
 * prefix-match in findFeatureDir fails for these.  This function falls back to
 * querying the specflow local DB (.specflow/features.db) for the spec_path.
 *
 * @param worktreePath - Root path of the worktree
 * @param featureId - Feature ID as registered in the blackboard
 * @returns Full path to feature directory, or null if not found
 */
export function resolveFeatureDirWithFallback(worktreePath: string, featureId: string): string | null {
  const specDir = join(worktreePath, '.specify', 'specs');
  const found = findFeatureDir(specDir, featureId);
  if (found) return found;

  // Fallback: check specflow local DB for spec_path
  const sfDbPath = join(worktreePath, '.specflow', 'features.db');
  if (!existsSync(sfDbPath)) return null;
  try {
    const db = new Database(sfDbPath, { readonly: true });
    const row = db.query('SELECT spec_path FROM features WHERE id = ?').get(featureId) as { spec_path: string } | null;
    db.close();
    if (row?.spec_path) {
      const candidate = join(worktreePath, row.spec_path);
      if (existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
}
