import { Command } from 'commander';
import { existsSync, readFileSync } from 'node:fs';
import { parseDependencyId } from 'ivy-blackboard/src/specflow-features';
import type { CliContext } from '../cli.ts';

// ─── Bundle manifest types ────────────────────────────────────────────────────

interface BundleFeature {
  /** Feature ID, e.g. "F-001" */
  id: string;
  /** Human-readable title */
  title: string;
  /** Optional description */
  description?: string;
  /**
   * Comma-separated dependency IDs. Use `projectId:featureId` for cross-project.
   * Example: "F-001" or "ragent:F-010,F-002"
   */
  dependsOn?: string;
  /** Priority level: P1 | P2 | P3 (default P2) */
  priority?: 'P1' | 'P2' | 'P3';
  /** Override the phase this feature starts at (default: queued) */
  phase?: string;
  /** Max number of phase failures before the feature is marked failed (default 3) */
  maxFailures?: number;
}

interface BundleManifest {
  /** Project ID — must already be registered on the blackboard */
  project: string;
  /** Optional default main branch for all features */
  mainBranch?: string;
  /** Features to register */
  features: BundleFeature[];
}

// ─── Cycle detection ──────────────────────────────────────────────────────────

/**
 * Detect cycles in the feature dependency graph using DFS.
 * Returns the cycle path as an array of IDs, or null if acyclic.
 */
function detectCycle(features: BundleFeature[]): string[] | null {
  const ids = new Set(features.map(f => f.id));
  const deps = new Map<string, string[]>();

  for (const f of features) {
    if (!f.dependsOn) {
      deps.set(f.id, []);
      continue;
    }
    // Only include same-bundle deps (cross-project deps are external, no cycle risk)
    const localDeps = f.dependsOn
      .split(',')
      .map(d => parseDependencyId(d.trim()))
      .filter(d => ids.has(d));
    deps.set(f.id, localDeps);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(id: string, path: string[]): string[] | null {
    if (inStack.has(id)) return [...path, id]; // cycle found
    if (visited.has(id)) return null;

    visited.add(id);
    inStack.add(id);

    for (const dep of deps.get(id) ?? []) {
      const cycle = dfs(dep, [...path, id]);
      if (cycle) return cycle;
    }

    inStack.delete(id);
    return null;
  }

  for (const f of features) {
    const cycle = dfs(f.id, []);
    if (cycle) return cycle;
  }

  return null;
}

/**
 * Topological sort (Kahn's algorithm) so dependencies are registered first.
 * Assumes the graph is acyclic (call detectCycle first).
 */
function topologicalSort(features: BundleFeature[]): BundleFeature[] {
  const ids = new Set(features.map(f => f.id));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>(); // dep → [features that depend on it]

  for (const f of features) {
    inDegree.set(f.id, 0);
    adj.set(f.id, []);
  }

  for (const f of features) {
    if (!f.dependsOn) continue;
    for (const depRef of f.dependsOn.split(',')) {
      const dep = parseDependencyId(depRef.trim());
      if (!ids.has(dep)) continue; // external dep, skip
      adj.get(dep)!.push(f.id);
      inDegree.set(f.id, (inDegree.get(f.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: BundleFeature[] = [];
  const featureMap = new Map(features.map(f => [f.id, f]));

  while (queue.length > 0) {
    const id = queue.shift()!;
    sorted.push(featureMap.get(id)!);
    for (const dependent of adj.get(id) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  return sorted;
}

// ─── Manifest validation ──────────────────────────────────────────────────────

function validateManifest(raw: unknown): BundleManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Bundle manifest must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  if (!obj.project || typeof obj.project !== 'string') {
    throw new Error('Bundle manifest must have a "project" string field');
  }
  if (!Array.isArray(obj.features) || obj.features.length === 0) {
    throw new Error('Bundle manifest must have a non-empty "features" array');
  }

  const features: BundleFeature[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < obj.features.length; i++) {
    const f = obj.features[i] as Record<string, unknown>;
    if (!f.id || typeof f.id !== 'string') {
      throw new Error(`Feature at index ${i} must have a string "id" field`);
    }
    if (!f.title || typeof f.title !== 'string') {
      throw new Error(`Feature "${f.id}" must have a string "title" field`);
    }
    if (seenIds.has(f.id as string)) {
      throw new Error(`Duplicate feature ID: ${f.id}`);
    }
    seenIds.add(f.id as string);
    features.push({
      id: f.id as string,
      title: f.title as string,
      description: typeof f.description === 'string' ? f.description : undefined,
      dependsOn: typeof f.dependsOn === 'string' ? f.dependsOn : undefined,
      priority: ['P1', 'P2', 'P3'].includes(f.priority as string)
        ? (f.priority as 'P1' | 'P2' | 'P3')
        : undefined,
      phase: typeof f.phase === 'string' ? f.phase : undefined,
      maxFailures: typeof f.maxFailures === 'number' ? f.maxFailures : undefined,
    });
  }

  return {
    project: obj.project as string,
    mainBranch: typeof obj.mainBranch === 'string' ? obj.mainBranch : undefined,
    features,
  };
}

// ─── Command registration ─────────────────────────────────────────────────────

/**
 * CLI command: ivy-heartbeat specflow-bundle
 *
 * Registers multiple SpecFlow features with their inter-dependencies in one call.
 * Designed for the orchestrator path (populates specflow_features table directly).
 *
 * Bundle manifest format (JSON):
 * {
 *   "project": "my-project",
 *   "mainBranch": "main",
 *   "features": [
 *     { "id": "F-001", "title": "Foundation" },
 *     { "id": "F-002", "title": "Dependent", "dependsOn": "F-001" },
 *     { "id": "F-003", "title": "Cross-project dep", "dependsOn": "other-project:F-010,F-001" }
 *   ]
 * }
 */
export function registerSpecFlowBundleCommand(
  parent: Command,
  getContext: () => CliContext
): void {
  parent
    .command('specflow-bundle')
    .description('Register multiple SpecFlow features with dependencies (orchestrator path)')
    .requiredOption('--file <path>', 'Path to JSON bundle manifest file')
    .option('--dry-run', 'Show what would be registered without creating anything', false)
    .action(async (opts) => {
      const ctx = getContext();
      const bb = ctx.bb;

      // Load and parse manifest
      if (!existsSync(opts.file)) {
        console.error(`Error: bundle file not found: ${opts.file}`);
        process.exit(1);
      }

      let manifest: BundleManifest;
      try {
        const raw = JSON.parse(readFileSync(opts.file, 'utf8'));
        manifest = validateManifest(raw);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error parsing bundle manifest: ${msg}`);
        process.exit(1);
      }

      // Validate project exists
      const project = bb.getProject(manifest.project);
      if (!project) {
        console.error(`Error: project "${manifest.project}" not found on blackboard`);
        process.exit(1);
      }

      // Detect cycles
      const cycle = detectCycle(manifest.features);
      if (cycle) {
        console.error(`Error: circular dependency detected: ${cycle.join(' → ')}`);
        process.exit(1);
      }

      // Topological sort — register dependencies first
      const sorted = topologicalSort(manifest.features);

      if (opts.dryRun) {
        console.log(`Dry run — would register ${sorted.length} feature(s) in project "${manifest.project}":`);
        for (const f of sorted) {
          const depStr = f.dependsOn ? ` (depends on: ${f.dependsOn})` : '';
          console.log(`  ${f.id}: ${f.title}${depStr}`);
        }
        return;
      }

      // Register each feature
      const registered: string[] = [];
      const skipped: string[] = [];
      const errors: Array<{ id: string; error: string }> = [];

      for (const f of sorted) {
        try {
          bb.upsertFeature({
            feature_id: f.id,
            project_id: manifest.project,
            title: f.title,
            description: f.description,
            main_branch: manifest.mainBranch ?? 'main',
            max_failures: f.maxFailures,
            ...(f.dependsOn ? { dependsOn: f.dependsOn } : {}),
            ...(f.phase ? { phase: f.phase as Parameters<typeof bb.upsertFeature>[0]['phase'] } : {}),
          });
          registered.push(f.id);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('FEATURE_EXISTS') || msg.includes('already exists')) {
            skipped.push(f.id);
          } else {
            errors.push({ id: f.id, error: msg });
          }
        }
      }

      if (ctx.json) {
        console.log(JSON.stringify({ registered, skipped, errors }));
      } else {
        if (registered.length > 0) {
          console.log(`Registered ${registered.length} feature(s): ${registered.join(', ')}`);
        }
        if (skipped.length > 0) {
          console.log(`Skipped ${skipped.length} (already existed): ${skipped.join(', ')}`);
        }
        if (errors.length > 0) {
          for (const e of errors) {
            console.error(`Error registering ${e.id}: ${e.error}`);
          }
          process.exit(1);
        }
        console.log('Done. The orchestrator will pick up features on the next heartbeat cycle.');
      }
    });
}
