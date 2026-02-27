/**
 * SpecFlow phase runner.
 *
 * Runs one SpecFlow phase via the specflow CLI, checks quality gates,
 * and chains the next phase by creating a new work item.
 */

import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, symlinkSync, lstatSync, cpSync, readFileSync, appendFileSync, unlinkSync, readdirSync } from 'node:fs';
import { Database as SpecflowLocalDb } from 'bun:sqlite';
import type { Blackboard } from '../blackboard.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';
import { getLauncher, logPathForSession } from './launcher.ts';
import {
  type SpecFlowPhase,
  type SpecFlowPhaseResult,
  type SpecFlowWorkItemMetadata,
  parseSpecFlowMeta,
  PHASE_RUBRICS,
  PHASE_ARTIFACTS,
  PHASE_EXPECTED_ARTIFACTS,
  PHASE_PREREQUISITES,
} from './specflow-types.ts';
import {
  extractProblemStatement,
  extractKeyDecisions,
  getFilesChangedSummary,
  formatFilesChanged,
} from '../lib/pr-body-extractor.ts';
import {
  createWorktree,
  ensureWorktree,
  removeWorktree,
  commitAll,
  pushBranch,
  createPR,
  getCurrentBranch,
  hasCommitsAhead,
  isCleanBranch,
  getDiffSummary,
  getChangedFiles,
} from './worktree.ts';
import { findFeatureDir } from './specflow/utils/find-feature-dir.ts';

const MAX_RETRIES = 1;
const QUALITY_THRESHOLD = 80;
const SPECFLOW_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const IMPLEMENT_TIMEOUT_MIN_MS = 30 * 60 * 1000; // 30 minutes minimum
const IMPLEMENT_TIMEOUT_PER_TASK_MS = 3 * 60 * 1000; // +3 minutes per task

// ─── Injectable specflow CLI runner (for testing) ─────────────────────

export type SpecFlowSpawner = (
  args: string[],
  cwd: string,
  timeoutMs: number
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

let spawner: SpecFlowSpawner = defaultSpawner;

async function defaultSpawner(
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const specflowBin = process.env.SPECFLOW_BIN ?? join(process.env.HOME ?? '', 'bin', 'specflow');
  const proc = Bun.spawn([specflowBin, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CLAUDECODE: undefined },
  });

  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill('SIGTERM');
  }, timeoutMs);

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  if (killed) {
    return { exitCode: -1, stdout, stderr: 'specflow timed out (SIGTERM)' };
  }

  return { exitCode, stdout, stderr };
}

export function setSpecFlowSpawner(fn: SpecFlowSpawner): void {
  spawner = fn;
}

export function resetSpecFlowSpawner(): void {
  spawner = defaultSpawner;
}

// ─── Injectable worktree operations (for testing) ─────────────────────

export interface WorktreeOps {
  createWorktree: typeof createWorktree;
  ensureWorktree: typeof ensureWorktree;
  removeWorktree: typeof removeWorktree;
  commitAll: typeof commitAll;
  pushBranch: typeof pushBranch;
  createPR: typeof createPR;
  getCurrentBranch: typeof getCurrentBranch;
  hasCommitsAhead: typeof hasCommitsAhead;
  isCleanBranch: typeof isCleanBranch;
  getDiffSummary: typeof getDiffSummary;
  getChangedFiles: typeof getChangedFiles;
}

const defaultWorktreeOps: WorktreeOps = {
  createWorktree,
  ensureWorktree,
  removeWorktree,
  commitAll,
  pushBranch,
  createPR,
  getCurrentBranch,
  hasCommitsAhead,
  isCleanBranch,
  getDiffSummary,
  getChangedFiles,
};

let worktreeOps: WorktreeOps = defaultWorktreeOps;

export function setWorktreeOps(ops: Partial<WorktreeOps>): void {
  worktreeOps = { ...defaultWorktreeOps, ...ops };
}

export function resetWorktreeOps(): void {
  worktreeOps = defaultWorktreeOps;
}

// ─── Main entry point ────────────────────────────────────────────────

/**
 * Run a single SpecFlow phase for a work item.
 *
 * Lifecycle:
 * 1. Determine/create worktree
 * 2. Run specflow CLI for the phase
 * 3. Check quality gate (specify, plan)
 * 4. On success: chain next phase or complete pipeline
 * 5. On gate failure: retry or mark failed
 */
export async function runSpecFlowPhase(
  bb: Blackboard,
  item: BlackboardWorkItem,
  project: { project_id: string; local_path: string },
  sessionId: string
): Promise<SpecFlowPhaseResult> {
  const meta = parseSpecFlowMeta(item.metadata);
  if (!meta) {
    throw new Error('Work item has no valid SpecFlow metadata');
  }

  let { specflow_feature_id: featureId } = meta;
  const { specflow_phase: phase } = meta;

  bb.appendEvent({
    actorId: sessionId,
    targetId: item.item_id,
    summary: `SpecFlow phase "${phase}" starting for ${featureId}`,
    metadata: { featureId, phase, retryCount: meta.retry_count ?? 0 },
  });

  // ─── Worktree setup ──────────────────────────────────────────────
  let worktreePath: string;
  const mainBranch = meta.main_branch ?? await worktreeOps.getCurrentBranch(project.local_path);
  const branch = `specflow-${featureId.toLowerCase()}`;

  if (!meta.worktree_path) {
    // First phase in pipeline (no worktree yet): create fresh worktree
    worktreePath = await worktreeOps.createWorktree(
      project.local_path,
      branch,
      project.project_id
    );
  } else if (meta.worktree_path) {
    // Subsequent phases: reuse existing worktree
    worktreePath = await worktreeOps.ensureWorktree(
      project.local_path,
      meta.worktree_path,
      branch
    );
  } else {
    // Fallback: derive worktree path and ensure it exists
    const wtBase = process.env.IVY_WORKTREE_DIR ?? join(process.env.HOME ?? '/tmp', '.pai', 'worktrees');
    worktreePath = join(wtBase, project.project_id, branch);
    worktreePath = await worktreeOps.ensureWorktree(project.local_path, worktreePath, branch);
  }

  bb.appendEvent({
    actorId: sessionId,
    targetId: item.item_id,
    summary: `Worktree ready at ${worktreePath}`,
    metadata: { worktreePath, phase },
  });

  // ─── Reset worktree state on retry (clean slate for new attempt) ───
  if (meta.retry_count && meta.retry_count > 0 && phase === 'implement') {
    try {
      const { execSync } = await import('node:child_process');
      execSync('git checkout -- .', { cwd: worktreePath, timeout: 10_000 });
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Reset worktree state for retry attempt ${meta.retry_count}`,
        metadata: { retryCount: meta.retry_count },
      });
    } catch {
      // Non-fatal — implement phase already handles dirty worktrees
    }
  }

  // ─── Ensure specflow is initialized in the worktree ─────────────
  const specflowDbPath = join(worktreePath, '.specflow', 'features.db');
  const legacyDbPath = join(worktreePath, '.specify', 'specflow.db');
  if (!existsSync(specflowDbPath) && !existsSync(legacyDbPath)) {
    // Strategy 0 (fastest + safest): symlink .specflow/ from worktree to source repo.
    // .specflow/ is gitignored so worktrees don't get it automatically.
    // Symlink means all agents share ONE DB — no divergent copies, no data loss.
    // SQLite handles concurrent readers natively; WAL mode serializes writes.
    const sourceSpecflowDir = join(project.local_path, '.specflow');
    const sourceLegacyDir = join(project.local_path, '.specify');
    const worktreeSpecflowDir = join(worktreePath, '.specflow');
    let dbLinked = false;

    if (existsSync(join(sourceSpecflowDir, 'features.db'))) {
      try {
        // Remove worktree .specflow if it exists (empty dir from checkout)
        if (existsSync(worktreeSpecflowDir)) {
          const stat = lstatSync(worktreeSpecflowDir);
          if (!stat.isSymbolicLink()) {
            // Directory exists but isn't a symlink — safe to replace since
            // we know it has no features.db (checked above in outer if)
          }
        } else {
          mkdirSync(dirname(worktreeSpecflowDir), { recursive: true });
        }
        // Create symlink: worktree/.specflow → source/.specflow
        if (!existsSync(worktreeSpecflowDir)) {
          symlinkSync(sourceSpecflowDir, worktreeSpecflowDir, 'dir');
        } else {
          // Directory exists (possibly empty from git) — symlink individual DB files
          symlinkSync(
            join(sourceSpecflowDir, 'features.db'),
            join(worktreeSpecflowDir, 'features.db')
          );
        }
        dbLinked = true;
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Symlinked specflow DB from source repo to worktree (shared, concurrent-safe)`,
          metadata: { source: sourceSpecflowDir, dest: worktreeSpecflowDir },
        });
      } catch {
        // Symlink failed (cross-filesystem, permissions) — fall through
      }
    } else if (existsSync(join(sourceLegacyDir, 'specflow.db'))) {
      try {
        mkdirSync(dirname(legacyDbPath), { recursive: true });
        symlinkSync(
          join(sourceLegacyDir, 'specflow.db'),
          legacyDbPath
        );
        dbLinked = true;
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Symlinked legacy specflow DB from source repo to worktree`,
          metadata: { source: sourceLegacyDir, dest: legacyDbPath },
        });
      } catch {
        // Symlink failed — fall through
      }
    }

    if (!dbLinked) {
      // Fallback: run specflow init
      // Try init strategies in order of preference:
      // 1. --from-features (imports existing feature definitions)
      // 2. --batch with --from-spec (non-interactive, uses app context)
      // 3. --batch with project ID as description (minimal fallback)
      const featuresPath = join(worktreePath, 'features.json');
      const appContextPath = join(worktreePath, '.specify', 'app-context.md');

      let initArgs: string[];
      if (existsSync(featuresPath)) {
        initArgs = ['init', '--from-features', featuresPath];
      } else if (existsSync(appContextPath)) {
        initArgs = ['init', '--batch', '--from-spec', appContextPath];
      } else {
        initArgs = ['init', '--batch', project.project_id];
      }

      const initResult = await spawner(initArgs, worktreePath, 60_000);
      if (initResult.exitCode !== 0) {
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `specflow init failed (exit ${initResult.exitCode}) in worktree`,
          metadata: { stderr: initResult.stderr.slice(0, 500) },
        });
        return { status: 'failed' };
      }
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Initialized specflow database in worktree`,
        metadata: { worktreePath },
      });
    }
  }

  // ─── Ensure .specflow is gitignored ──────────────────────────────
  // The .specflow symlink resolves to an absolute path containing the user's
  // home directory, which triggers gitleaks pai-personal-path rule.
  // Ensure .specflow/ is in .gitignore so agents don't accidentally stage it.
  const worktreeGitignore = join(worktreePath, '.gitignore');
  try {
    const gitignoreContent = existsSync(worktreeGitignore)
      ? readFileSync(worktreeGitignore, 'utf-8')
      : '';
    if (!gitignoreContent.includes('.specflow')) {
      appendFileSync(worktreeGitignore, '\n# SpecFlow state (symlinked, contains absolute paths)\n.specflow\n');
    }
  } catch {
    // Non-fatal — gitleaks may still block but this is best-effort
  }

  // ─── Sync untracked spec artifacts to worktree ─────────────────────
  // Spec artifacts (spec.md, plan.md, tasks.md) are often untracked/gitignored
  // in the source repo, so they don't appear in the worktree after checkout.
  // Copy any that exist in source but not in worktree.
  const specDirs = ['.specify/specs', '.specflow/specs'];
  for (const specBase of specDirs) {
    const sourceSpecDir = join(project.local_path, specBase);
    if (!existsSync(sourceSpecDir)) continue;

    try {
      const entries = readdirSync(sourceSpecDir, { withFileTypes: true });
      const prefix = featureId.toLowerCase();
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith(prefix)) continue;

        const sourceFeatureDir = join(sourceSpecDir, entry.name);
        const destFeatureDir = join(worktreePath, specBase, entry.name);
        mkdirSync(destFeatureDir, { recursive: true });

        for (const artifact of readdirSync(sourceFeatureDir)) {
          const src = join(sourceFeatureDir, artifact);
          const dest = join(destFeatureDir, artifact);
          if (!existsSync(dest)) {
            cpSync(src, dest, { recursive: true });
          }
        }

        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Synced spec artifacts from source to worktree for ${featureId}`,
          metadata: { sourceDir: sourceFeatureDir, destDir: destFeatureDir },
        });
        break; // Found the matching feature dir
      }
    } catch {
      // Non-fatal — specflow will report missing artifacts
    }
  }

  // ─── Ensure feature exists in specflow DB ──────────────────────────
  // GH-* features (from the evaluator) need initial registration.
  // F-NNN features may also need re-registration in retries when the
  // worktree was recreated with a fresh specflow.db from features.json.
  if (phase === 'specify') {
    // Check if the feature exists via specflow status --json
    const checkResult = await spawner(['status', '--json'], worktreePath, 10_000);
    const featureMissing = checkResult.exitCode !== 0
      || !checkResult.stdout.includes(`"id":"${featureId}"`)
      && !checkResult.stdout.includes(`"id": "${featureId}"`);

    if (featureMissing) {
      const originalFeatureId = featureId;
      const featureName = item.title.replace(/^SpecFlow \w+.*?: /, '');
      const featureDesc = item.description ?? featureName;
      const addResult = await spawner(
        ['add', featureName, featureDesc, '--priority', '1'],
        worktreePath,
        30_000
      );
      if (addResult.exitCode === 0) {
        // Parse "Added feature F-019: ..." to get the specflow ID
        const match = addResult.stdout.match(/Added feature (F-\d+)/);
        if (match) {
          featureId = match[1];
          meta.specflow_feature_id = featureId;
        }
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Registered feature ${originalFeatureId} as ${featureId} in specflow`,
          metadata: { originalFeatureId, specflowFeatureId: featureId },
        });

        // Enrich with defaults so batch specify can run
        await spawner([
          'enrich', featureId,
          '--problem-type', 'manual_workaround',
          '--urgency', 'user_demand',
          '--primary-user', 'developers',
          '--integration-scope', 'extends_existing',
        ], worktreePath, 30_000);
      } else {
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Failed to register feature ${featureId} in specflow (exit ${addResult.exitCode})`,
          metadata: { stderr: addResult.stderr.slice(0, 500) },
        });
        return { status: 'failed' };
      }
    }
  }

  // ─── Phase prerequisite check ───────────────────────────────────
  // Verify the specflow DB has the feature at a phase that allows
  // the requested phase to run. Prevents infinite retry loops when
  // artifacts exist on disk but the DB hasn't been advanced.
  const prerequisite = PHASE_PREREQUISITES[phase];
  if (prerequisite) {
    const statusResult = await spawner(['status', '--json'], worktreePath, 10_000);
    if (statusResult.exitCode === 0) {
      try {
        const statusData = JSON.parse(statusResult.stdout);
        const features = statusData.features ?? statusData;
        const feature = (Array.isArray(features) ? features : []).find(
          (f: { id?: string }) => f.id === featureId
        );
        const dbPhase = feature?.phase ?? 'none';
        const dbStatus = feature?.status ?? 'pending';
        // Phase order for comparison
        const phaseOrder: Record<string, number> = {
          none: 0, specify: 1, plan: 2, tasks: 3, implement: 4, complete: 5,
        };
        const prereqOrder = phaseOrder[prerequisite] ?? 0;
        const currentOrder = phaseOrder[dbPhase] ?? 0;

        // ─── Stale status reset ─────────────────────────────────
        // If the feature is marked "complete" but we're trying to run a
        // non-terminal phase, the status is stale (manual DB edit, lost
        // artifacts, etc.). Reset it so the specflow CLI doesn't skip.
        if (dbStatus === 'complete' && phase !== 'complete') {
          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `Resetting stale status "complete" for ${featureId} — phase "${phase}" still needed`,
            metadata: { phase, dbPhase, dbStatus, featureId },
          });
          await spawner(['reset', featureId], worktreePath, 10_000);
          // After reset, feature is at phase=specify, status=pending.
          // Set phase to the prerequisite for the requested phase so
          // specflow CLI will actually run.
          const prereqPhaseForReset: Record<string, string> = {
            plan: 'specify',
            tasks: 'plan',
            implement: 'tasks',
          };
          const targetPhase = prereqPhaseForReset[phase];
          if (targetPhase) {
            await spawner(['phase', featureId, targetPhase], worktreePath, 10_000);
          }
        } else if (currentOrder < prereqOrder) {
          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `SpecFlow phase "${phase}" requires "${prerequisite}" but feature ${featureId} is at phase "${dbPhase}" — releasing for later retry`,
            metadata: { phase, prerequisite, dbPhase, featureId },
          });
          // Return blocked — the prerequisite phase must complete first.
          // The item will be re-dispatched once the prerequisite phase advances the DB.
          return { status: 'blocked' };
        }
      } catch {
        // JSON parse failed — proceed and let specflow CLI handle it
      }
    }
  }

  // ─── Build CLI arguments ─────────────────────────────────────────
  const cliArgs = buildCliArgs(phase, featureId, meta);

  // ─── Run specflow CLI ────────────────────────────────────────────
  // For specify/plan/tasks: extract prompt from specflow and run via
  // Max-authenticated launcher (avoids double-invocation where specflow's
  // internal `claude -p` lacks Max OAuth credentials).
  const LAUNCHER_PHASES: SpecFlowPhase[] = ['specify', 'plan', 'tasks'];
  const result = LAUNCHER_PHASES.includes(phase)
    ? await runPhaseViaLauncher(phase, featureId, cliArgs, worktreePath, sessionId, bb, item)
    : await spawner(cliArgs, worktreePath, SPECFLOW_TIMEOUT_MS);

  if (result.exitCode === -1) {
    // Timeout
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `SpecFlow phase "${phase}" timed out for ${featureId}`,
      metadata: { phase, featureId, timeout: SPECFLOW_TIMEOUT_MS },
    });
    return { status: 'failed' };
  }

  if (result.exitCode !== 0) {
    // ─── Complete phase: detect and generate missing artifacts ─────
    if (phase === 'complete') {
      const missingArtifacts = detectMissingArtifacts(result.stdout, result.stderr);
      if (missingArtifacts.length > 0) {
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `SpecFlow complete failed — missing artifacts: ${missingArtifacts.join(', ')}. Generating...`,
          metadata: { phase, missingArtifacts, exitCode: result.exitCode },
        });

        const generated = await generateMissingArtifacts(
          missingArtifacts, featureId, worktreePath, sessionId, bb, item.item_id
        );

        if (generated) {
          // Retry specflow complete after generating artifacts
          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `Retrying specflow complete for ${featureId} after artifact generation`,
            metadata: { phase, featureId },
          });

          const retryResult = await spawner(cliArgs, worktreePath, SPECFLOW_TIMEOUT_MS);
          if (retryResult.exitCode === 0) {
            bb.appendEvent({
              actorId: sessionId,
              targetId: item.item_id,
              summary: `SpecFlow complete succeeded on retry for ${featureId}`,
              metadata: { phase, featureId },
            });
            // Fall through to the complete phase cleanup below
          } else {
            bb.appendEvent({
              actorId: sessionId,
              targetId: item.item_id,
              summary: `SpecFlow complete still failed after artifact generation (exit ${retryResult.exitCode}) — proceeding to PR anyway`,
              metadata: { phase, exitCode: retryResult.exitCode, stderr: retryResult.stderr.slice(0, 500) },
            });
            // Fall through — still push/PR so code gets reviewed
          }
        } else {
          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `Failed to generate missing artifacts for ${featureId} — proceeding to PR anyway`,
            metadata: { phase, missingArtifacts },
          });
          // Fall through — still push/PR so code gets reviewed
        }
      } else {
        // Complete failed for a non-artifact reason (e.g., test coverage, failing tests)
        // Still proceed — push/PR so the code gets reviewed
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `SpecFlow complete validation failed for ${featureId} — creating PR for review`,
          metadata: { phase, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
        });
      }
    } else {
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `SpecFlow phase "${phase}" failed (exit ${result.exitCode}) for ${featureId}`,
        metadata: { phase, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
      });
      return { status: 'failed' };
    }
  }

  bb.appendEvent({
    actorId: sessionId,
    targetId: item.item_id,
    summary: `SpecFlow phase "${phase}" completed (exit 0) for ${featureId}`,
    metadata: { phase, featureId },
  });

  // ─── Post-phase artifact existence check ──────────────────────────
  // Guard against phases that exit 0 but don't produce expected artifacts
  // (e.g., specflow tasks exits 0 with "already complete" but no tasks.md)
  const expectedArtifact = PHASE_EXPECTED_ARTIFACTS[phase];
  if (expectedArtifact) {
    const specDir = join(worktreePath, '.specify', 'specs');
    let featureDirForArtifact = findFeatureDir(specDir, featureId);
    if (!featureDirForArtifact) {
      // Fallback: query local specflow DB for spec_path.
      // Handles ID remapping (e.g. feature registered as F-107 but spec dir is "F-103-sync-watch-mode").
      const specflowDbPath = join(worktreePath, '.specflow', 'features.db');
      if (existsSync(specflowDbPath)) {
        try {
          const specflowDb = new SpecflowLocalDb(specflowDbPath, { readonly: true });
          const row = specflowDb.query('SELECT spec_path FROM features WHERE id = ?').get(featureId) as { spec_path: string } | null;
          specflowDb.close();
          if (row?.spec_path) {
            const resolved = join(worktreePath, row.spec_path);
            if (existsSync(resolved)) featureDirForArtifact = resolved;
          }
        } catch {
          // Non-fatal — fall through to featureId-based path
        }
      }
    }
    const artifactFile = featureDirForArtifact
      ? join(featureDirForArtifact, expectedArtifact)
      : join(specDir, featureId, expectedArtifact);

    if (!existsSync(artifactFile)) {
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `SpecFlow phase "${phase}" exited 0 but ${expectedArtifact} missing for ${featureId} — treating as failure`,
        metadata: { phase, featureId, expectedArtifact, checkedPath: artifactFile },
      });
      return { status: 'failed' };
    }

    // ─── Sync artifacts back from worktree to source repo ──────────────
    // Prevents orphaned work products when post-processing fails (content
    // filter, quality gate error, crash). The source repo always has the
    // latest artifacts regardless of pipeline outcome.
    const featureDirInWorktree = featureDirForArtifact ?? join(specDir, featureId);
    const specDirs = ['.specify/specs', '.specflow/specs'];
    for (const specBase of specDirs) {
      const sourceSpecDir = join(project.local_path, specBase);
      if (!existsSync(sourceSpecDir)) continue;

      try {
        const entries = readdirSync(sourceSpecDir, { withFileTypes: true });
        const prefix = featureId.toLowerCase();
        for (const entry of entries) {
          if (!entry.isDirectory() || !entry.name.toLowerCase().startsWith(prefix)) continue;
          const sourceFeatureDir = join(sourceSpecDir, entry.name);
          // Copy all artifacts from worktree feature dir to source
          for (const file of readdirSync(featureDirInWorktree)) {
            const src = join(featureDirInWorktree, file);
            const dest = join(sourceFeatureDir, file);
            cpSync(src, dest, { recursive: true });
          }
          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `Synced artifacts from worktree back to source for ${featureId}`,
            metadata: { sourceDir: sourceFeatureDir, phase },
          });
          break;
        }
      } catch {
        // Non-fatal — artifact exists in worktree, will be available on next run
      }
    }
  }

  // ─── Implement: specflow outputs a prompt — launch Claude to execute it ──
  if (phase === 'implement' && result.stdout.trim()) {
    // Detect uncommitted changes from a previous failed attempt (GH-19)
    let implementPrompt = result.stdout.trim();

    // Prepend coding-mode override to prevent PAI Algorithm ceremony from
    // consuming the agent's time budget. The spec/plan/tasks in the prompt
    // already capture requirements — no need for OBSERVE/THINK/PLAN phases.
    const codingModePreamble = [
      '## EXECUTION MODE: Direct Implementation',
      '',
      'You are a headless coding agent in a dispatch pipeline with a strict time budget.',
      'The spec, plan, and tasks below ARE your requirements — they replace any ISC or reverse engineering.',
      '',
      'CRITICAL OVERRIDE — DO NOT:',
      '- Use the PAI Algorithm format (no OBSERVE/THINK/PLAN/BUILD/EXECUTE/VERIFY/LEARN phase headers)',
      '- Create Ideal State Criteria via TaskCreate',
      '- Perform capability audits or reverse engineering',
      '- Execute voice notification curl commands',
      '- Enter plan mode (EnterPlanMode)',
      '- Spawn research agents or councils',
      '',
      'INSTEAD — Go straight to coding:',
      '1. Read the tasks below and work through them in order',
      '2. For each task: read relevant code, write failing test, implement, verify',
      '3. Run `bun test` after each significant change',
      '4. Output [FEATURE COMPLETE], [FEATURE PARTIAL], or [FEATURE BLOCKED] when done',
      '',
      'Every minute spent on ceremony is a minute NOT spent writing code.',
      '',
      '---',
      '',
    ].join('\n');
    implementPrompt = codingModePreamble + implementPrompt;
    const isClean = await worktreeOps.isCleanBranch(worktreePath);

    if (!isClean) {
      // Capture diff summary and prepend context so the agent can review existing work
      let diffSummary = '';
      try {
        diffSummary = await worktreeOps.getDiffSummary(worktreePath, mainBranch);
      } catch {
        diffSummary = '(unable to generate diff summary)';
      }

      const priorWorkContext = [
        '## IMPORTANT: Prior Implementation Work Detected',
        '',
        'A previous implementation attempt left uncommitted changes in this worktree.',
        'Review the existing changes before writing new code.',
        '',
        '**Existing changes:**',
        '```',
        diffSummary,
        '```',
        '',
        'Steps:',
        '1. Review the existing uncommitted changes with `git diff`',
        '2. Determine if they are correct and complete',
        '3. Fix any issues found',
        '4. Do NOT re-implement from scratch — build on the existing work',
        '',
        '---',
        '',
      ].join('\n');

      implementPrompt = priorWorkContext + implementPrompt;

      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Detected uncommitted changes from prior attempt for ${featureId} — augmenting prompt`,
        metadata: { featureId, diffSummary: diffSummary.slice(0, 500) },
      });
    } else {
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Worktree is clean for ${featureId} — proceeding with fresh implementation`,
        metadata: { featureId },
      });
    }

    // Scale timeout based on task count in the prompt.
    // Count "### T-" headers (standard specflow task format) in the prompt.
    const taskCount = (implementPrompt.match(/^### T-/gm) || []).length;
    const implementTimeoutMs = Math.max(
      IMPLEMENT_TIMEOUT_MIN_MS,
      taskCount * IMPLEMENT_TIMEOUT_PER_TASK_MS
    );

    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Launching Claude to implement ${featureId} (${taskCount} tasks, ${Math.round(implementTimeoutMs / 60_000)}min timeout)`,
      metadata: { promptLength: implementPrompt.length, hasExistingChanges: !isClean, taskCount, timeoutMs: implementTimeoutMs },
    });

    const launcher = getLauncher();
    const launchResult = await launcher({
      sessionId,
      prompt: implementPrompt,
      workDir: worktreePath,
      timeoutMs: implementTimeoutMs,
    });

    if (launchResult.exitCode !== 0) {
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Implementation agent failed (exit ${launchResult.exitCode}) for ${featureId}`,
        metadata: { exitCode: launchResult.exitCode },
      });
      return { status: 'failed' };
    }

    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Implementation agent completed for ${featureId}`,
      metadata: { featureId },
    });
  }

  // ─── Quality gate check ──────────────────────────────────────────
  let evalScore: number | null = null;
  const rubric = PHASE_RUBRICS[phase];
  if (rubric) {
    const gateResult = await checkQualityGate(
      worktreePath, phase, featureId, bb, item, sessionId
    );

    if (!gateResult.passed) {
      const retryCount = meta.retry_count ?? 0;
      if (retryCount < MAX_RETRIES) {
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Quality gate failed (${gateResult.score}%) — retrying ${featureId} phase "${phase}" (attempt ${retryCount + 1}/${MAX_RETRIES})`,
          metadata: { phase, score: gateResult.score, retryCount: retryCount + 1 },
        });
        // Retry: caller should complete original item, retry item supersedes
        return { status: 'retry' };
      } else {
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Quality gate failed (${gateResult.score}%) — max retries exceeded for ${featureId} phase "${phase}"`,
          metadata: { phase, score: gateResult.score, maxRetries: MAX_RETRIES },
        });
        // Pipeline exhausted — mark as failed so it's not silently "completed"
        return { status: 'failed' };
      }
    }

    evalScore = gateResult.score;
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Quality gate passed (${gateResult.score}%) for ${featureId} phase "${phase}"`,
      metadata: { phase, score: gateResult.score },
    });
  }

  // ─── Implement phase: commit changes ────────────────────────────
  if (phase === 'implement') {
    await handleImplementPhase(bb, item, meta, worktreePath, sessionId);
  }

  // ─── Complete phase: push branch & create PR ──────────────────
  if (phase === 'complete') {
    await handleCompletePhase(bb, item, meta, worktreePath, mainBranch, sessionId, project.local_path, project.remote_repo);
  }

  return { status: 'completed' };
}

// ─── Phase-via-launcher ─────────────────────────────────────────────────

/**
 * Run a specflow phase (specify/plan/tasks) by extracting the prompt from
 * specflow and executing it via the Max-authenticated launcher.
 *
 * This avoids the double-invocation problem where specflow's internal
 * `claude -p` call lacks Max OAuth credentials and falls back to API
 * credits (which may be zero on a Max plan).
 *
 * Flow:
 * 1. Run specflow with SPECFLOW_PROMPT_OUTPUT → specflow writes prompt JSON, exits 0
 * 2. Parse the prompt JSON (contains prompt + systemPrompt)
 * 3. Launch Claude via the Max-authenticated launcher (full tool access)
 * 4. Advance the specflow DB phase (since specflow exited before updating it)
 */
async function runPhaseViaLauncher(
  phase: SpecFlowPhase,
  featureId: string,
  cliArgs: string[],
  worktreePath: string,
  sessionId: string,
  bb: Blackboard,
  item: BlackboardWorkItem,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // Step 1: Run specflow in prompt-output mode
  // Set env var that headless.ts checks — it writes the prompt to this file and exits.
  // Using process.env so the injectable spawner (and its default impl) propagate it.
  const promptFile = join(worktreePath, '.specflow-prompt.json');
  process.env.SPECFLOW_PROMPT_OUTPUT = promptFile;

  let sfResult: { exitCode: number; stdout: string; stderr: string };
  try {
    sfResult = await spawner(cliArgs, worktreePath, SPECFLOW_TIMEOUT_MS);
  } finally {
    delete process.env.SPECFLOW_PROMPT_OUTPUT;
  }

  // If specflow failed (validation error, feature not found, etc.), propagate
  if (sfResult.exitCode !== 0) {
    return sfResult;
  }

  // Step 2: Parse the prompt from the output file
  // If specflow exited 0 but no prompt file exists, the phase artifact already
  // exists (specflow said "already complete"). Just advance the DB phase.
  if (!existsSync(promptFile)) {
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Phase ${phase} artifact already exists for ${featureId}, advancing DB phase`,
      metadata: { phase, featureId },
    });
    const phaseResult = await spawner(['phase', featureId, phase], worktreePath, 10_000);
    return {
      exitCode: phaseResult.exitCode,
      stdout: sfResult.stdout,
      stderr: phaseResult.exitCode !== 0 ? phaseResult.stderr : '',
    };
  }

  let promptData: { prompt: string; systemPrompt?: string };
  try {
    const raw = readFileSync(promptFile, 'utf-8');
    promptData = JSON.parse(raw);
  } catch (err) {
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Failed to read prompt from ${promptFile}: ${err}`,
    };
  }

  // Clean up temp file
  try { unlinkSync(promptFile); } catch {}

  // Step 3: Build the full prompt for the launcher
  // The launcher runs Claude with full tool access (Write, Read, Edit, Bash)
  // so Claude can write artifact files directly to disk
  const fullPrompt = [
    promptData.systemPrompt
      ? `[System Context] ${promptData.systemPrompt}`
      : '',
    '',
    'IMPORTANT: You have full tool access. Write the artifact file directly to disk using the Write tool.',
    `After creating the file, output [PHASE COMPLETE: ${phase.toUpperCase()}] in your response.`,
    '',
    promptData.prompt,
  ].filter(Boolean).join('\n');

  // Step 4: Launch Claude via Max-authenticated launcher
  bb.appendEvent({
    actorId: sessionId,
    targetId: item.item_id,
    summary: `Launching Claude (Max auth) for ${phase} phase of ${featureId}`,
    metadata: { phase, featureId, promptLength: fullPrompt.length },
  });

  const launcher = getLauncher();
  const launchResult = await launcher({
    sessionId: `${sessionId}-${phase}`,
    prompt: fullPrompt,
    workDir: worktreePath,
    timeoutMs: SPECFLOW_TIMEOUT_MS,
  });

  if (launchResult.exitCode !== 0) {
    return {
      exitCode: launchResult.exitCode,
      stdout: launchResult.stdout,
      stderr: launchResult.stderr,
    };
  }

  // Step 5: Advance the specflow DB phase
  // The specflow command exited early (prompt-output mode) without updating the DB,
  // so we advance it manually after successful Claude execution.
  const phaseResult = await spawner(['phase', featureId, phase], worktreePath, 10_000);
  if (phaseResult.exitCode !== 0) {
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Warning: specflow DB phase advancement failed for ${featureId} → ${phase} (exit ${phaseResult.exitCode})`,
      metadata: { stderr: phaseResult.stderr.slice(0, 500) },
    });
    // Non-fatal: artifact may still exist on disk, quality gate will verify
  }

  return { exitCode: 0, stdout: launchResult.stdout, stderr: launchResult.stderr };
}

// ─── CLI argument builder ──────────────────────────────────────────────

function buildCliArgs(
  phase: SpecFlowPhase,
  featureId: string,
  meta: SpecFlowWorkItemMetadata
): string[] {
  switch (phase) {
    case 'specify':
      // Don't force --batch: specflow's headless mode auto-enables batch
      // when rich decomposition data is available. Manually-added features
      // lack decomposition data and fail with --batch.
      return ['specify', featureId];
    case 'implement':
      return ['implement', '--feature', featureId];
    case 'complete':
      return ['complete', featureId];
    default:
      // plan, tasks
      return [phase, featureId];
  }
}

// ─── Quality gate ──────────────────────────────────────────────────────

interface GateResult {
  passed: boolean;
  score: number;
  feedback: string;
}

async function checkQualityGate(
  worktreePath: string,
  phase: SpecFlowPhase,
  featureId: string,
  bb: Blackboard,
  item: BlackboardWorkItem,
  sessionId: string
): Promise<GateResult> {
  const rubric = PHASE_RUBRICS[phase];
  const artifact = PHASE_ARTIFACTS[phase];

  if (!rubric || !artifact) {
    return { passed: true, score: 100, feedback: '' };
  }

  // Find the artifact file: .specify/specs/{feature-dir}/{artifact}
  const specDir = join(worktreePath, '.specify', 'specs');
  const featureDir = findFeatureDir(specDir, featureId);
  const artifactPath = featureDir
    ? join(featureDir, artifact)
    : join(specDir, featureId, artifact);

  const result = await spawner(
    ['eval', 'run', '--file', artifactPath, '--rubric', rubric, '--json'],
    worktreePath,
    120_000 // 2 minute timeout for eval
  );

  // specflow eval exits with code 1 when score is below threshold (not a crash).
  // Always try to parse JSON output first — only treat as total failure if unparseable.
  try {
    const evalOutput = JSON.parse(result.stdout);
    // specflow eval --json returns { results: [{ passed, score, output }], ... }
    const testResult = evalOutput.results?.[0];
    const score = testResult?.score ?? evalOutput.score ?? evalOutput.percentage ?? 0;
    // Normalize: specflow returns 0.0-1.0, quality gate expects 0-100
    const scorePercent = score <= 1 ? Math.round(score * 100) : score;
    const feedback = testResult?.output ?? evalOutput.feedback ?? evalOutput.details ?? result.stdout;
    return {
      passed: scorePercent >= QUALITY_THRESHOLD,
      score: scorePercent,
      feedback: typeof feedback === 'string' ? feedback : JSON.stringify(feedback),
    };
  } catch {
    // JSON parse failed — this is a real eval failure (crash, timeout, etc.)
    if (result.exitCode !== 0) {
      return { passed: false, score: 0, feedback: `Eval failed (exit ${result.exitCode}): ${result.stderr || result.stdout}` };
    }
    return { passed: false, score: 0, feedback: `Failed to parse eval output: ${result.stdout}` };
  }
}

// ─── Missing artifact detection & generation ────────────────────────────

/**
 * Check whether specflow complete failed due to missing docs.md or verify.md.
 * Returns the list of missing artifact names.
 */
export function detectMissingArtifacts(stdout: string, stderr: string): string[] {
  const combined = `${stdout}\n${stderr}`;
  const missing: string[] = [];
  if (/docs\.md/i.test(combined) && /missing|not found|required|does not exist/i.test(combined)) {
    missing.push('docs.md');
  }
  if (/verify\.md/i.test(combined) && /missing|not found|required|does not exist/i.test(combined)) {
    missing.push('verify.md');
  }
  // Also detect if both are mentioned generically
  if (missing.length === 0 && /missing.*artifacts?/i.test(combined)) {
    missing.push('docs.md', 'verify.md');
  }
  return missing;
}

/**
 * Build a prompt for Claude to generate docs.md.
 */
function buildDocsPrompt(featureId: string, specDir: string): string {
  return [
    `You are generating documentation for SpecFlow feature ${featureId}.`,
    ``,
    `Create a file at ${specDir}/docs.md that documents what changed in this feature.`,
    ``,
    `Steps:`,
    `1. Run \`git diff main --stat\` to see what files changed`,
    `2. Run \`git diff main\` to review the actual changes`,
    `3. Read any spec.md and plan.md in the spec directory for context`,
    `4. Write ${specDir}/docs.md with:`,
    `   - A summary of what the feature does`,
    `   - What files were added or modified`,
    `   - Any configuration or setup changes needed`,
    `   - Usage examples if applicable`,
    ``,
    `Keep the documentation concise and focused on what a developer needs to know.`,
    `Write the file using the Write tool. Do not ask for confirmation.`,
  ].join('\n');
}

/**
 * Build a prompt for Claude to generate verify.md.
 */
function buildVerifyPrompt(featureId: string, specDir: string): string {
  return [
    `You are verifying SpecFlow feature ${featureId}.`,
    ``,
    `Create a file at ${specDir}/verify.md that documents verification results.`,
    ``,
    `CRITICAL: The file MUST contain these exact section headers (specflow complete validates them):`,
    `  ## Pre-Verification Checklist`,
    `  ## Smoke Test Results`,
    `  ## Browser Verification`,
    `  ## API Verification`,
    ``,
    `Steps:`,
    `1. Read any spec.md and plan.md in the spec directory to understand acceptance criteria`,
    `2. Run \`bun test\` to execute the test suite`,
    `3. Check if the feature-specific tests pass`,
    `4. Write ${specDir}/verify.md with ALL four required sections:`,
    ``,
    `   ## Pre-Verification Checklist`,
    `   - List each acceptance criterion from spec.md with PASS/FAIL status`,
    ``,
    `   ## Smoke Test Results`,
    `   - Test suite results: pass/fail counts, runtime`,
    `   - Feature-specific test results`,
    ``,
    `   ## Browser Verification`,
    `   - If the feature has a UI: describe visual verification`,
    `   - If CLI/library only: write "N/A — CLI/library feature, no browser UI"`,
    ``,
    `   ## API Verification`,
    `   - If the feature has API endpoints or MCP tools: describe API verification`,
    `   - If no API: write "N/A — no API endpoints in this feature"`,
    ``,
    `   End with a final verdict: PASS or FAIL with reasoning.`,
    ``,
    `Write the file using the Write tool. Do not ask for confirmation.`,
  ].join('\n');
}

/**
 * Generate missing docs.md and/or verify.md by launching Claude sessions.
 * Returns true if all missing artifacts were generated.
 */
async function generateMissingArtifacts(
  missingArtifacts: string[],
  featureId: string,
  worktreePath: string,
  sessionId: string,
  bb: Blackboard,
  itemId: string
): Promise<boolean> {
  const specDir = join(worktreePath, '.specify', 'specs');
  const featureDir = findFeatureDir(specDir, featureId) ?? join(specDir, featureId);

  const launcher = getLauncher();

  for (const artifact of missingArtifacts) {
    const prompt = artifact === 'docs.md'
      ? buildDocsPrompt(featureId, featureDir)
      : buildVerifyPrompt(featureId, featureDir);

    bb.appendEvent({
      actorId: sessionId,
      targetId: itemId,
      summary: `Launching Claude to generate ${artifact} for ${featureId}`,
      metadata: { artifact, featureId },
    });

    const result = await launcher({
      sessionId: `${sessionId}-${artifact.replace('.md', '')}`,
      prompt,
      workDir: worktreePath,
      timeoutMs: SPECFLOW_TIMEOUT_MS,
    });

    if (result.exitCode !== 0) {
      bb.appendEvent({
        actorId: sessionId,
        targetId: itemId,
        summary: `Failed to generate ${artifact} for ${featureId} (exit ${result.exitCode})`,
        metadata: { artifact, exitCode: result.exitCode },
      });
      return false;
    }

    // Verify the file was actually created
    const artifactPath = join(featureDir, artifact);
    if (!existsSync(artifactPath)) {
      bb.appendEvent({
        actorId: sessionId,
        targetId: itemId,
        summary: `Claude session completed but ${artifact} was not created at ${artifactPath}`,
        metadata: { artifact, artifactPath },
      });
      return false;
    }

    bb.appendEvent({
      actorId: sessionId,
      targetId: itemId,
      summary: `Generated ${artifact} for ${featureId}`,
      metadata: { artifact, featureId },
    });
  }

  return true;
}

// ─── Implement phase handling ──────────────────────────────────────────

async function handleImplementPhase(
  bb: Blackboard,
  item: BlackboardWorkItem,
  meta: SpecFlowWorkItemMetadata,
  worktreePath: string,
  sessionId: string,
): Promise<void> {
  const featureId = meta.specflow_feature_id;

  // Commit implementation changes — complete phase handles push/PR
  const sha = await worktreeOps.commitAll(worktreePath, `feat(specflow): ${featureId} implementation`);

  if (sha) {
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Committed implementation changes for ${featureId}`,
      metadata: { featureId, commitSha: sha },
    });
  } else {
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `No new changes to commit for ${featureId} — chaining to complete phase`,
      metadata: { featureId },
    });
  }
}

// ─── Complete phase handling ──────────────────────────────────────────

async function handleCompletePhase(
  bb: Blackboard,
  item: BlackboardWorkItem,
  meta: SpecFlowWorkItemMetadata,
  worktreePath: string,
  mainBranch: string,
  sessionId: string,
  projectPath: string,
  remoteRepo: string | null,
): Promise<void> {
  const featureId = meta.specflow_feature_id;

  // Commit any artifacts created by `specflow complete` (docs.md, verify.md, etc.)
  const sha = await worktreeOps.commitAll(worktreePath, `chore(specflow): ${featureId} completion artifacts`);
  if (sha) {
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Committed completion artifacts for ${featureId}`,
      metadata: { featureId, commitSha: sha },
    });
  }

  // Detect the actual branch name (implementation agent may rename it)
  const branch = await worktreeOps.getCurrentBranch(worktreePath);

  // Check if there are commits ahead of main to push
  const hasCommits = await worktreeOps.hasCommitsAhead(worktreePath, mainBranch);
  if (!hasCommits) {
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `No commits ahead of ${mainBranch} for ${featureId} — skipping PR`,
      metadata: { featureId, branch },
    });
    return;
  }

  // Verify the diff contains actual source code, not just spec artifacts.
  // If the implement phase produced no code, only .specify/ and CHANGELOG files
  // will be in the diff — don't create a PR for spec-only changes.
  const changedFiles = await worktreeOps.getChangedFiles(worktreePath, mainBranch);
  const sourceFiles = changedFiles.filter(f => !f.startsWith('.specify/') && f !== 'CHANGELOG.md');
  if (sourceFiles.length === 0) {
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Implementation produced no source code for ${featureId} — only spec artifacts. Skipping PR.`,
      metadata: { featureId, branch, changedFiles },
    });
    return;
  }

  // Push and create PR
  await worktreeOps.pushBranch(worktreePath, branch);

  // Build enhanced PR body with feature summary
  const specDir = join(worktreePath, '.specify', 'specs');
  const featureDir = findFeatureDir(specDir, featureId);
  const specPath = featureDir ? join(featureDir, 'spec.md') : join(specDir, featureId, 'spec.md');
  const planPath = featureDir ? join(featureDir, 'plan.md') : join(specDir, featureId, 'plan.md');

  let summary = "See spec.md for full feature details";
  let approach: string[] = ["See plan.md for implementation details"];

  // Try to extract content from spec and plan files
  try {
    if (existsSync(specPath)) {
      const specContent = await Bun.file(specPath).text();
      summary = extractProblemStatement(specContent);
    }
  } catch (error) {
    // Use fallback if spec read fails
  }

  try {
    if (existsSync(planPath)) {
      const planContent = await Bun.file(planPath).text();
      approach = extractKeyDecisions(planContent);
    }
  } catch (error) {
    // Use fallback if plan read fails
  }

  // Get files changed summary
  const filesChanged = await getFilesChangedSummary(mainBranch, branch);
  const filesChangedTable = formatFilesChanged(filesChanged);

  // Assemble PR body
  let prBody = [
    `# Feature: ${featureId}`,
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Implementation Approach',
    '',
    ...approach.map(point => `- ${point}`),
    '',
    '## Files Changed',
    '',
    filesChangedTable,
    '',
    '## Full Documentation',
    '',
    `- [Specification](${featureDir ? featureDir.split('/').pop() + '/spec.md' : featureId + '/spec.md'})`,
    `- [Technical Plan](${featureDir ? featureDir.split('/').pop() + '/plan.md' : featureId + '/plan.md'})`,
  ].join('\n');

  // Truncate to 4000 characters if needed
  if (prBody.length > 4000) {
    prBody = prBody.substring(0, 3997) + '...';
  }

  const pr = await worktreeOps.createPR(
    worktreePath,
    `feat(specflow): ${featureId} ${item.title.replace(/^SpecFlow (?:implement|complete): /, '')}`,
    prBody,
    mainBranch,
    branch
  );

  bb.appendEvent({
    actorId: sessionId,
    targetId: item.item_id,
    summary: `Created PR #${pr.number} for ${featureId}`,
    metadata: { prNumber: pr.number, prUrl: pr.url, branch },
  });

  // Create code review work item for the feature PR
  const repo = meta.github_repo ?? remoteRepo;
  if (repo) {
    const reviewItemId = `review-${meta.specflow_project_id}-pr-${pr.number}`;
    try {
      bb.createWorkItem({
        id: reviewItemId,
        title: `Code review: PR #${pr.number} - ${featureId}`,
        description: `AI code review for SpecFlow feature PR #${pr.number}\nFeature: ${featureId}\nBranch: ${branch}\nRepo: ${repo}`,
        project: meta.specflow_project_id,
        source: 'code_review',
        sourceRef: pr.url,
        priority: 'P1',
        metadata: JSON.stringify({
          pr_number: pr.number,
          pr_url: pr.url,
          repo,
          branch,
          main_branch: mainBranch,
          implementation_work_item_id: item.item_id,
          review_status: null,
        }),
      });
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Created code review work item ${reviewItemId} for PR #${pr.number}`,
        metadata: { reviewItemId, prNumber: pr.number },
      });
    } catch {
      // Review item creation failed (non-fatal)
    }
  }

  // Clean up worktree now that PR is created
  try {
    await worktreeOps.removeWorktree(projectPath, worktreePath);
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Cleaned up worktree for completed feature ${featureId}`,
      metadata: { worktreePath },
    });
  } catch {
    // Non-fatal — staleness cleanup will handle it
  }
}
