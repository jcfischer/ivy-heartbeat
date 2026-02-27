import { join } from 'node:path';
import { readdirSync, statSync } from 'node:fs';

/**
 * Find the feature directory under a spec root by featureId prefix.
 *
 * Matches any directory whose name starts with the featureId (case-insensitive).
 * Uses statSync (follows symlinks) so symlinked spec dirs are found too.
 * Returns null if no match is found or the spec root doesn't exist.
 */
export function findFeatureDir(specDir: string, featureId: string): string | null {
  try {
    const entries = readdirSync(specDir, { withFileTypes: true });
    const prefix = featureId.toLowerCase();
    for (const entry of entries) {
      if (!entry.name.toLowerCase().startsWith(prefix)) continue;
      try {
        const stat = statSync(join(specDir, entry.name));
        if (stat.isDirectory()) return join(specDir, entry.name);
      } catch { /* broken symlink or permission error — skip */ }
    }
  } catch {
    // specDir doesn't exist
  }
  return null;
}
