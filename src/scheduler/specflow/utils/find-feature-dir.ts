import { join } from 'node:path';
import { readdirSync } from 'node:fs';

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
