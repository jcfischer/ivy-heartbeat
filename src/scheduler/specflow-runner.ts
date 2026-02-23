/**
 * SpecFlow phase runner.
 *
 * Runs one SpecFlow phase via the specflow CLI, checks quality gates,
 * and chains the next phase by creating a new work item.
 */

import { join, dirname } from 'node:path';
import { existsSync, readdirSync, mkdirSync, symlinkSync, lstatSync, cpSync, readFileSync, appendFileSync } from 'node:fs';
import type { Blackboard } from '../blackboard.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';
import { getLauncher, logPathForSession } from './launcher.ts';
import {
  type SpecFlowPhase,
  type SpecFlowWorkItemMetadata,
  parseSpecFlowMeta,
  nextPhase,
  PHASE_RUBRICS,
  PHASE_ARTIFACTS,
  PHASE_EXPECTED_ARTIFACTS,
} from './specflow-types.ts';
import {
  createWorktree,
  ensureWorktree,
  removeWorktree,
  commitAll,
  pushBranch,
  createPR,
  getCurrentBranch,
} from './worktree.ts';

const MAX_RETRIES = 1;
const QUALITY_THRESHOLD = 80;
const SPECFLOW_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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
}

const defaultWorktreeOps: WorktreeOps = {
  createWorktree,
  ensureWorktree,
  removeWorktree,
  commitAll,
  pushBranch,
  createPR,
  getCurrentBranch,
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
): Promise<boolean> {
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
        return false;
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
        return false;
      }
    }
  }

  // ─── Build CLI arguments ─────────────────────────────────────────
  const cliArgs = buildCliArgs(phase, featureId, meta);

  // ─── Run specflow CLI ────────────────────────────────────────────
  const result = await spawner(cliArgs, worktreePath, SPECFLOW_TIMEOUT_MS);

  if (result.exitCode === -1) {
    // Timeout
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `SpecFlow phase "${phase}" timed out for ${featureId}`,
      metadata: { phase, featureId, timeout: SPECFLOW_TIMEOUT_MS },
    });
    return false;
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
              summary: `SpecFlow complete still failed after artifact generation (exit ${retryResult.exitCode})`,
              metadata: { phase, exitCode: retryResult.exitCode, stderr: retryResult.stderr.slice(0, 500) },
            });
            return false;
          }
        } else {
          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `Failed to generate missing artifacts for ${featureId} — aborting complete`,
            metadata: { phase, missingArtifacts },
          });
          return false;
        }
      } else {
        // Complete failed for a non-artifact reason
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `SpecFlow phase "${phase}" failed (exit ${result.exitCode}) for ${featureId}`,
          metadata: { phase, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
        });
        return false;
      }
    } else {
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `SpecFlow phase "${phase}" failed (exit ${result.exitCode}) for ${featureId}`,
        metadata: { phase, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
      });
      return false;
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
    const featureDirForArtifact = findFeatureDir(specDir, featureId);
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
      return false;
    }
  }

  // ─── Implement: specflow outputs a prompt — launch Claude to execute it ──
  if (phase === 'implement' && result.stdout.trim()) {
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Launching Claude to implement ${featureId}`,
      metadata: { promptLength: result.stdout.length },
    });

    const launcher = getLauncher();
    const launchResult = await launcher({
      sessionId,
      prompt: result.stdout.trim(),
      workDir: worktreePath,
      timeoutMs: SPECFLOW_TIMEOUT_MS,
    });

    if (launchResult.exitCode !== 0) {
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Implementation agent failed (exit ${launchResult.exitCode}) for ${featureId}`,
        metadata: { exitCode: launchResult.exitCode },
      });
      return false;
    }

    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Implementation agent completed for ${featureId}`,
      metadata: { featureId },
    });
  }

  // ─── Quality gate check ──────────────────────────────────────────
  const rubric = PHASE_RUBRICS[phase];
  if (rubric) {
    const gateResult = await checkQualityGate(
      worktreePath, phase, featureId, bb, item, sessionId
    );

    if (!gateResult.passed) {
      const retryCount = meta.retry_count ?? 0;
      if (retryCount < MAX_RETRIES) {
        await chainRetry(bb, item, meta, gateResult.feedback, worktreePath, mainBranch);
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Quality gate failed (${gateResult.score}%) — retrying ${featureId} phase "${phase}" (attempt ${retryCount + 1}/${MAX_RETRIES})`,
          metadata: { phase, score: gateResult.score, retryCount: retryCount + 1 },
        });
        // Return true: retry supersedes original item — caller should complete it
        return true;
      } else {
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Quality gate failed (${gateResult.score}%) — max retries exceeded for ${featureId} phase "${phase}"`,
          metadata: { phase, score: gateResult.score, maxRetries: MAX_RETRIES },
        });
        // Return true: pipeline exhausted — complete item, don't release for infinite re-dispatch
        return true;
      }
    }

    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Quality gate passed (${gateResult.score}%) for ${featureId} phase "${phase}"`,
      metadata: { phase, score: gateResult.score },
    });
  }

  // ─── Implement phase: git ops ────────────────────────────────────
  if (phase === 'implement') {
    await handleImplementPhase(bb, item, meta, worktreePath, branch, mainBranch, sessionId);
  }

  // ─── Complete phase: cleanup ─────────────────────────────────────
  if (phase === 'complete') {
    await spawner(['complete', featureId], worktreePath, 60_000);
    try {
      await worktreeOps.removeWorktree(project.local_path, worktreePath);
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Cleaned up worktree for completed feature ${featureId}`,
        metadata: { worktreePath },
      });
    } catch {
      // Non-fatal — staleness cleanup will handle it
    }
    return true;
  }

  // ─── Chain next phase ────────────────────────────────────────────
  const next = nextPhase(phase);
  if (next) {
    await chainNextPhase(bb, item, meta, next, worktreePath, mainBranch);
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Chained next phase "${next}" for ${featureId}`,
      metadata: { currentPhase: phase, nextPhase: next },
    });
  }

  return true;
}

// ─── CLI argument builder ──────────────────────────────────────────────

function buildCliArgs(
  phase: SpecFlowPhase,
  featureId: string,
  meta: SpecFlowWorkItemMetadata
): string[] {
  switch (phase) {
    case 'specify':
      return ['specify', featureId, '--batch'];
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

  if (result.exitCode !== 0) {
    return { passed: false, score: 0, feedback: `Eval failed (exit ${result.exitCode}): ${result.stderr || result.stdout}` };
  }

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
    return { passed: false, score: 0, feedback: `Failed to parse eval output: ${result.stdout}` };
  }
}

/**
 * Find the feature directory matching a feature ID.
 * Feature dirs are named like: f-019-specflow-dispatch-agent
 */
function findFeatureDir(specDir: string, featureId: string): string | null {
  try {
    const entries = readdirSync(specDir, { withFileTypes: true });
    const prefix = featureId.toLowerCase().replace('-', '-');
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.toLowerCase().startsWith(prefix.toLowerCase())) {
        return join(specDir, entry.name);
      }
    }
  } catch {
    // specDir doesn't exist
  }
  return null;
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
    `Steps:`,
    `1. Read any spec.md and plan.md in the spec directory to understand acceptance criteria`,
    `2. Run \`bun test\` to execute the test suite`,
    `3. Check if the feature-specific tests pass`,
    `4. Write ${specDir}/verify.md with:`,
    `   - Test results summary (pass/fail counts)`,
    `   - Which acceptance criteria are met`,
    `   - Any manual verification you performed`,
    `   - A final verdict: PASS or FAIL with reasoning`,
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

// ─── Chain next phase ──────────────────────────────────────────────────

async function chainNextPhase(
  bb: Blackboard,
  item: BlackboardWorkItem,
  meta: SpecFlowWorkItemMetadata,
  next: SpecFlowPhase,
  worktreePath: string,
  mainBranch: string
): Promise<void> {
  const newMeta: SpecFlowWorkItemMetadata = {
    specflow_feature_id: meta.specflow_feature_id,
    specflow_phase: next,
    specflow_project_id: meta.specflow_project_id,
    worktree_path: worktreePath,
    main_branch: mainBranch,
    retry_count: 0,
    // Carry GitHub metadata for evaluator dedup
    github_issue_url: meta.github_issue_url,
    github_issue_number: meta.github_issue_number,
    github_repo: meta.github_repo,
  };

  bb.createWorkItem({
    id: `specflow-${meta.specflow_feature_id}-${next}`,
    title: `SpecFlow ${next}: ${meta.specflow_feature_id}`,
    description: `SpecFlow phase "${next}" for feature ${meta.specflow_feature_id}`,
    project: meta.specflow_project_id,
    source: 'specflow',
    sourceRef: meta.github_issue_url ?? meta.specflow_feature_id,
    priority: item.priority ?? 'P2',
    metadata: JSON.stringify(newMeta),
  });
}

// ─── Chain retry ────────────────────────────────────────────────────────

async function chainRetry(
  bb: Blackboard,
  item: BlackboardWorkItem,
  meta: SpecFlowWorkItemMetadata,
  feedback: string,
  worktreePath: string,
  mainBranch: string
): Promise<void> {
  const retryCount = (meta.retry_count ?? 0) + 1;

  const newMeta: SpecFlowWorkItemMetadata = {
    specflow_feature_id: meta.specflow_feature_id,
    specflow_phase: meta.specflow_phase,
    specflow_project_id: meta.specflow_project_id,
    worktree_path: worktreePath,
    main_branch: mainBranch,
    retry_count: retryCount,
    eval_feedback: feedback,
    // Carry GitHub metadata for evaluator dedup
    github_issue_url: meta.github_issue_url,
    github_issue_number: meta.github_issue_number,
    github_repo: meta.github_repo,
  };

  bb.createWorkItem({
    id: `specflow-${meta.specflow_feature_id}-${meta.specflow_phase}-retry${retryCount}`,
    title: `SpecFlow ${meta.specflow_phase} (retry ${retryCount}): ${meta.specflow_feature_id}`,
    description: `SpecFlow phase "${meta.specflow_phase}" retry for feature ${meta.specflow_feature_id}\n\nEval feedback:\n${feedback}`,
    project: meta.specflow_project_id,
    source: 'specflow',
    sourceRef: meta.github_issue_url ?? meta.specflow_feature_id,
    priority: item.priority ?? 'P2',
    metadata: JSON.stringify(newMeta),
  });
}

// ─── Implement phase handling ──────────────────────────────────────────

async function handleImplementPhase(
  bb: Blackboard,
  item: BlackboardWorkItem,
  meta: SpecFlowWorkItemMetadata,
  worktreePath: string,
  branch: string,
  mainBranch: string,
  sessionId: string
): Promise<void> {
  const featureId = meta.specflow_feature_id;

  // Check if there are changes to commit
  const sha = await worktreeOps.commitAll(worktreePath, `feat(specflow): ${featureId} implementation`);

  if (!sha) {
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `No changes to commit for ${featureId} — completing without PR`,
      metadata: { featureId },
    });
    return;
  }

  // Push and create PR
  await worktreeOps.pushBranch(worktreePath, branch);

  const prBody = [
    `## SpecFlow Feature: ${featureId}`,
    '',
    `Automated implementation via SpecFlow pipeline.`,
    '',
    `- Spec: see \`spec.md\` on this branch`,
    `- Plan: see \`plan.md\` on this branch`,
  ].join('\n');

  const pr = await worktreeOps.createPR(
    worktreePath,
    `feat(specflow): ${featureId} ${item.title.replace(/^SpecFlow implement: /, '')}`,
    prBody,
    mainBranch
  );

  bb.appendEvent({
    actorId: sessionId,
    targetId: item.item_id,
    summary: `Created PR #${pr.number} for ${featureId}`,
    metadata: { prNumber: pr.number, prUrl: pr.url, commitSha: sha },
  });
}
