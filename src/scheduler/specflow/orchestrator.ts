import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, symlinkSync, lstatSync, readdirSync } from 'node:fs';
import { Database as SpecflowDb } from 'bun:sqlite';
import type { Blackboard } from '../../blackboard.ts';
import type { SpecFlowFeature } from 'ivy-blackboard/src/types';
import {
  ADVANCE_MAP,
  GATE_MAP,
  toCompletedPhase,
  type OrchestratorAction,
  type OrchestratorConfig,
  type OrchestratorResult,
} from './orchestrator-types.ts';
import { checkQualityGate } from './gates/quality-gate.ts';
import { checkCodeGate } from './gates/code-gate.ts';
import { SpecifyExecutor } from './phases/specify.ts';
import { PlanExecutor } from './phases/plan.ts';
import { TasksExecutor } from './phases/tasks.ts';
import { ImplementExecutor } from './phases/implement.ts';
import { CompleteExecutor } from './phases/complete.ts';
import type { PhaseExecutor } from './types.ts';
import { createWorktree, ensureWorktree } from './infra/worktree.ts';
import { resolveFeatureDirWithFallback } from './utils/find-feature-dir.ts';

const EXECUTORS: PhaseExecutor[] = [
  new SpecifyExecutor(),
  new PlanExecutor(),
  new TasksExecutor(),
  new ImplementExecutor(),
  new CompleteExecutor(),
];

const DEFAULT_PHASE_TIMEOUT_MIN = 20;

/**
 * Per-phase stale timeout overrides (minutes).
 * Implementing can run 30-153+ min depending on task count; other phases are fast.
 */
const PHASE_TIMEOUT_MAP: Record<string, number> = {
  specifying: 20,
  planning: 20,
  tasking: 20,
  implementing: 180,
  completing: 20,
};

function isStale(phaseStartedAt: string | null, timeoutMin: number): boolean {
  if (!phaseStartedAt) return true;
  const elapsed = Date.now() - new Date(phaseStartedAt).getTime();
  return elapsed > timeoutMin * 60_000;
}

/**
 * Determine what action the orchestrator should take for a given feature.
 * Pure function — no side effects.
 */
export function determineAction(
  feature: SpecFlowFeature,
  timeoutMin: number = DEFAULT_PHASE_TIMEOUT_MIN,
): OrchestratorAction {
  // Terminal states
  if (feature.phase === 'completed' || feature.phase === 'failed') {
    return { type: 'wait', reason: 'terminal state' };
  }

  // Blocked — needs human intervention
  if (feature.status === 'blocked') {
    return { type: 'wait', reason: 'blocked' };
  }

  // Max failures exceeded
  if (feature.failure_count >= feature.max_failures) {
    return {
      type: 'fail',
      reason: `max failures exceeded (${feature.failure_count}/${feature.max_failures})`,
    };
  }

  // Active session — check if stale
  if (feature.current_session && feature.status === 'active') {
    const effectiveTimeout = PHASE_TIMEOUT_MAP[feature.phase] ?? timeoutMin;
    if (isStale(feature.phase_started_at, effectiveTimeout)) {
      return { type: 'release', reason: 'phase timeout exceeded' };
    }
    return { type: 'wait', reason: 'session active' };
  }

  // *ing phase with succeeded status → run gate check
  if (feature.phase.endsWith('ing') && feature.status === 'succeeded') {
    const gate = GATE_MAP[feature.phase] ?? 'pass';
    return { type: 'check-gate', gate };
  }

  // *ed phase with pending status → advance to next *ing phase
  if (feature.phase.endsWith('ed') && feature.status === 'pending') {
    const next = ADVANCE_MAP[feature.phase];
    if (next) {
      return { type: 'advance', fromPhase: feature.phase, toPhase: next };
    }
  }

  // pending status → run the current phase
  if (feature.status === 'pending') {
    return { type: 'run-phase', phase: feature.phase };
  }

  return { type: 'wait', reason: 'no action available' };
}

/**
 * Release all features currently marked active.
 *
 * Call this on server startup: any feature that was active belongs to the
 * previous server process (now dead). Releasing them immediately lets the
 * new process re-dispatch without waiting for the stale timeout.
 */
export function releaseOrphanedFeatures(bb: Blackboard, sessionId: string): number {
  let released = 0;
  const features = bb.listFeatures({ status: 'active' });
  for (const feature of features) {
    try {
      bb.updateFeature(feature.feature_id, {
        status: 'pending',
        current_session: null,
        last_error: 'Released: server restarted (previous session died)',
      });
      released++;
    } catch {
      // non-fatal
    }
  }
  if (released > 0) {
    bb.appendEvent({
      actorId: sessionId,
      targetId: 'system',
      summary: `Released ${released} orphaned feature(s) on startup`,
      metadata: { released },
    });
  }
  return released;
}

/**
 * Release features whose active session has exceeded the timeout.
 */
async function releaseStuckFeatures(
  features: SpecFlowFeature[],
  bb: Blackboard,
  timeoutMin: number,
  sessionId: string,
): Promise<number> {
  let released = 0;
  for (const feature of features) {
    const action = determineAction(feature, timeoutMin);
    if (action.type !== 'release') continue;
    try {
      bb.updateFeature(feature.feature_id, {
        status: 'pending',
        current_session: null,
        last_error: `Released: ${action.reason}`,
      });
      bb.appendEvent({
        actorId: sessionId,
        targetId: feature.feature_id,
        summary: `Released stuck feature ${feature.feature_id}: ${action.reason}`,
        metadata: { featureId: feature.feature_id, phase: feature.phase },
      });
      released++;
    } catch {
      // non-fatal
    }
  }
  return released;
}

/**
 * Symlink .specflow/ from the source repo into the worktree.
 * .specflow/ is gitignored so worktrees don't get it automatically.
 * Symlink means all agents share one DB — no divergent copies.
 */
function ensureSpecflowInWorktree(worktreePath: string, projectPath: string): void {
  const sourceSpecflowDir = join(projectPath, '.specflow');
  if (!existsSync(join(sourceSpecflowDir, 'features.db'))) return;

  const worktreeSpecflowDir = join(worktreePath, '.specflow');
  if (existsSync(join(worktreeSpecflowDir, 'features.db'))) return; // already there

  try {
    if (!existsSync(worktreeSpecflowDir)) {
      mkdirSync(dirname(worktreeSpecflowDir), { recursive: true });
      symlinkSync(sourceSpecflowDir, worktreeSpecflowDir, 'dir');
    } else {
      // Directory exists (possibly empty from git checkout) — symlink DB files individually
      const featuresDest = join(worktreeSpecflowDir, 'features.db');
      if (!existsSync(featuresDest)) {
        symlinkSync(join(sourceSpecflowDir, 'features.db'), featuresDest);
      }
      const evalsDest = join(worktreeSpecflowDir, 'evals.db');
      if (!existsSync(evalsDest) && existsSync(join(sourceSpecflowDir, 'evals.db'))) {
        symlinkSync(join(sourceSpecflowDir, 'evals.db'), evalsDest);
      }
    }
  } catch {
    // Non-fatal — specflow will fall back or fail with a clear error
  }
}

/**
 * Symlink the feature's spec directory from the source repo into the worktree.
 * The specflow CLI writes spec artifacts (spec.md, plan.md, etc.) to the absolute
 * spec_path which lives in the source repo. Quality gates check the worktree path.
 * Symlinking ensures gates can find the artifacts without copying files.
 *
 * Handles ID-remapped features (e.g. F-107 registered in blackboard but spec dir
 * is named F-103-sync-watch-mode): falls back to querying the specflow local DB.
 */
function ensureSpecDirInWorktree(worktreePath: string, projectPath: string, featureId: string): void {
  try {
    const srcSpecsDir = join(projectPath, '.specify', 'specs');

    // Find the source spec dir: try prefix match first, then specflow DB fallback
    let srcDirName: string | null = null;

    const entries = readdirSync(srcSpecsDir, { withFileTypes: true });
    const prefix = featureId.toLowerCase();
    const srcEntry = entries.find(
      (e) => e.isDirectory() && e.name.toLowerCase().startsWith(prefix)
    );
    if (srcEntry) {
      srcDirName = srcEntry.name;
    } else {
      // Fallback: query the specflow local DB for spec_path (handles ID remapping)
      const specflowDbPath = join(worktreePath, '.specflow', 'features.db');
      if (existsSync(specflowDbPath)) {
        try {
          const specflowDb = new SpecflowDb(specflowDbPath, { readonly: true });
          const row = specflowDb.query('SELECT spec_path FROM features WHERE id = ?').get(featureId) as { spec_path: string } | null;
          specflowDb.close();
          if (row?.spec_path) {
            // spec_path is relative to project root (e.g. ".specify/specs/F-103-sync-watch-mode")
            const dirName = row.spec_path.split('/').pop();
            if (dirName && existsSync(join(srcSpecsDir, dirName))) {
              srcDirName = dirName;
            }
          }
        } catch {
          // Non-fatal — fall through
        }
      }
    }

    if (!srcDirName) return; // no spec dir in source repo yet

    const srcDir = join(srcSpecsDir, srcDirName);
    const destSpecsDir = join(worktreePath, '.specify', 'specs');
    const destDir = join(destSpecsDir, srcDirName);

    if (existsSync(destDir)) return; // already there (e.g. committed via git)

    mkdirSync(destSpecsDir, { recursive: true });
    symlinkSync(srcDir, destDir, 'dir');
  } catch {
    // Non-fatal
  }
}

/**
 * Set up or reuse a worktree for a feature. Returns the worktree path.
 */
async function setupWorktree(
  feature: SpecFlowFeature,
  projectPath: string,
): Promise<string> {
  const branch = `specflow-${feature.feature_id.toLowerCase()}`;
  let worktreePath: string;
  if (feature.worktree_path) {
    worktreePath = await ensureWorktree(projectPath, feature.worktree_path, branch);
  } else {
    // createWorktree computes the path from IVY_WORKTREE_DIR and returns it
    worktreePath = await createWorktree(projectPath, branch, feature.project_id);
  }
  ensureSpecflowInWorktree(worktreePath, projectPath);
  ensureSpecDirInWorktree(worktreePath, projectPath, feature.feature_id);
  return worktreePath;
}

/**
 * Check the gate for a completed *ing phase. Advances phase to *ed if passed,
 * otherwise increments failure count and resets to pending.
 * Returns true if gate passed.
 */
async function checkGateAndAdvance(
  feature: SpecFlowFeature,
  bb: Blackboard,
  sessionId: string,
): Promise<boolean> {
  const gate = GATE_MAP[feature.phase] ?? 'pass';
  const mainBranch = feature.main_branch ?? 'main';
  const worktreePath = feature.worktree_path ?? '';

  let passed = true;
  let gateDetails = 'auto-pass';

  if (gate === 'quality') {
    const qr = await checkQualityGate(worktreePath, feature.phase, feature.feature_id);
    passed = qr.passed;
    gateDetails = `score ${qr.score ?? 'n/a'}`;
    if (!passed) gateDetails += ' (below threshold)';

    // Persist quality score
    const scoreUpdate: Partial<SpecFlowFeature> = {};
    if (feature.phase === 'specifying' && qr.score !== null) {
      scoreUpdate.specify_score = qr.score;
    } else if (feature.phase === 'planning' && qr.score !== null) {
      scoreUpdate.plan_score = qr.score;
    }
    if (Object.keys(scoreUpdate).length > 0) {
      try { bb.updateFeature(feature.feature_id, scoreUpdate); } catch {}
    }
  } else if (gate === 'artifact') {
    const featureDir = resolveFeatureDirWithFallback(worktreePath, feature.feature_id);
    const tasksPath = featureDir ? join(featureDir, 'tasks.md') : null;
    passed = !!(tasksPath && existsSync(tasksPath));
    gateDetails = passed ? 'tasks.md present' : 'tasks.md missing';
  } else if (gate === 'code') {
    const cr = await checkCodeGate(worktreePath, mainBranch);
    passed = cr.passed;
    gateDetails = passed ? `${cr.changedFiles} source file(s) changed` : cr.reason;
  }

  bb.appendEvent({
    actorId: sessionId,
    targetId: feature.feature_id,
    summary: `Gate "${gate}" for ${feature.phase}: ${passed ? 'PASSED' : 'FAILED'} (${gateDetails})`,
    metadata: { gate, phase: feature.phase, passed, gateDetails },
  });

  if (passed) {
    const completedPhase = toCompletedPhase(feature.phase);
    bb.updateFeature(feature.feature_id, {
      phase: completedPhase as SpecFlowFeature['phase'],
      status: 'pending',
    });
    return true;
  } else {
    bb.updateFeature(feature.feature_id, {
      status: 'pending',
      failure_count: feature.failure_count + 1,
      last_error: `Gate "${gate}" failed: ${gateDetails}`,
    });
    return false;
  }
}

/**
 * Run the appropriate phase executor for a feature.
 */
async function runPhase(
  feature: SpecFlowFeature,
  bb: Blackboard,
  config: OrchestratorConfig,
  sessionId: string,
): Promise<{ advanced: boolean; failed: boolean; error?: string }> {
  const executor = EXECUTORS.find(e => e.canRun(feature));
  if (!executor) {
    return {
      advanced: false,
      failed: true,
      error: `No executor available for phase "${feature.phase}"`,
    };
  }

  const project = bb.getProject(feature.project_id);
  if (!project?.local_path) {
    return {
      advanced: false,
      failed: true,
      error: `Project "${feature.project_id}" not found or missing local_path`,
    };
  }

  let worktreePath: string;
  try {
    worktreePath = await setupWorktree(feature, project.local_path);
  } catch (err) {
    return { advanced: false, failed: true, error: `Worktree setup failed: ${err}` };
  }

  // Mark feature as active
  bb.updateFeature(feature.feature_id, {
    status: 'active',
    current_session: sessionId,
    worktree_path: worktreePath,
    branch_name: `specflow-${feature.feature_id.toLowerCase()}`,
    phase_started_at: new Date().toISOString(),
  });

  bb.appendEvent({
    actorId: sessionId,
    targetId: feature.feature_id,
    summary: `Starting phase "${feature.phase}" for ${feature.feature_id}`,
    metadata: { phase: feature.phase, worktreePath },
  });

  const result = await executor.execute(feature, bb, {
    worktreePath,
    projectPath: project.local_path,
    timeoutMs: config.phaseTimeoutMin * 60_000,
    sessionId,
  });

  if (result.status === 'succeeded') {
    const updates: Partial<SpecFlowFeature> = { status: 'succeeded', current_session: null };
    if (typeof result.metadata?.prNumber === 'number') updates.pr_number = result.metadata.prNumber;
    if (typeof result.metadata?.prUrl === 'string') updates.pr_url = result.metadata.prUrl;
    if (typeof result.metadata?.commitSha === 'string') updates.commit_sha = result.metadata.commitSha;
    bb.updateFeature(feature.feature_id, updates);

    bb.appendEvent({
      actorId: sessionId,
      targetId: feature.feature_id,
      summary: `Phase "${feature.phase}" succeeded for ${feature.feature_id}`,
      metadata: { phase: feature.phase, ...result.metadata },
    });
    return { advanced: true, failed: false };
  } else {
    const newCount = feature.failure_count + 1;
    bb.updateFeature(feature.feature_id, {
      status: 'pending',
      current_session: null,
      failure_count: newCount,
      last_error: result.error ?? 'Unknown error',
      last_phase_error: result.error ?? 'Unknown error',
    });

    bb.appendEvent({
      actorId: sessionId,
      targetId: feature.feature_id,
      summary: `Phase "${feature.phase}" failed for ${feature.feature_id} (attempt ${newCount}/${feature.max_failures})`,
      metadata: { phase: feature.phase, error: result.error },
    });
    return { advanced: false, failed: true, error: result.error };
  }
}

/**
 * Main orchestrator entry point. Called once per heartbeat cycle.
 *
 * Queries actionable features, releases stuck ones, then processes
 * one action per feature according to the state machine.
 */
export async function orchestrateSpecFlow(
  bb: Blackboard,
  config: OrchestratorConfig,
  sessionId?: string,
): Promise<OrchestratorResult> {
  const sid = sessionId ?? `orchestrator-${Date.now()}`;
  const result: OrchestratorResult = {
    featuresProcessed: 0,
    featuresAdvanced: 0,
    featuresReleased: 0,
    featuresFailed: 0,
    errors: [],
  };

  const features = bb.getActionableFeatures(config.maxConcurrent);
  if (features.length === 0) return result;

  // First pass: release stuck (active + timed out) features
  result.featuresReleased = await releaseStuckFeatures(
    features,
    bb,
    config.phaseTimeoutMin,
    sid,
  );

  // Re-fetch so released features show updated status
  const actionable = bb.getActionableFeatures(config.maxConcurrent);

  for (const feature of actionable) {
    result.featuresProcessed++;

    // Drain loop: keep processing this feature until it blocks (run-phase) or
    // reaches a terminal/wait state. This avoids burning extra heartbeat cycles
    // (up to 60 min each) on instant transitions like advance and gate checks.
    let current: SpecFlowFeature | null = feature;
    while (current) {
      const action = determineAction(current, config.phaseTimeoutMin);
      let continueWithFeature = false;

      try {
        switch (action.type) {
          case 'wait':
            break;

          case 'release':
            // Shouldn't happen after first pass, but handle defensively
            bb.updateFeature(current.feature_id, {
              status: 'pending',
              current_session: null,
              last_error: action.reason,
            });
            result.featuresReleased++;
            continueWithFeature = true; // re-evaluate after release
            break;

          case 'fail':
            bb.updateFeature(current.feature_id, {
              phase: 'failed',
              status: 'failed',
              last_error: action.reason,
            });
            bb.appendEvent({
              actorId: sid,
              targetId: current.feature_id,
              summary: `Feature ${current.feature_id} marked failed: ${action.reason}`,
              metadata: { featureId: current.feature_id, reason: action.reason },
            });
            result.featuresFailed++;
            break;

          case 'advance':
            bb.updateFeature(current.feature_id, {
              phase: action.toPhase as SpecFlowFeature['phase'],
              status: 'pending',
            });
            bb.appendEvent({
              actorId: sid,
              targetId: current.feature_id,
              summary: `Advanced ${current.feature_id}: ${action.fromPhase} → ${action.toPhase}`,
              metadata: { fromPhase: action.fromPhase, toPhase: action.toPhase },
            });
            result.featuresAdvanced++;
            continueWithFeature = true; // immediately run the phase we advanced into
            break;

          case 'check-gate': {
            const gateAdvanced = await checkGateAndAdvance(current, bb, sid);
            if (gateAdvanced) {
              result.featuresAdvanced++;
              continueWithFeature = true; // gate passed → advance to next phase immediately
            }
            break;
          }

          case 'run-phase': {
            const phaseRes = await runPhase(current, bb, config, sid);
            if (phaseRes.failed) {
              result.featuresFailed++;
              if (phaseRes.error) {
                result.errors.push({ featureId: current.feature_id, error: phaseRes.error });
              }
            } else {
              // Phase succeeded — immediately run gate check
              const fresh = bb.getFeature(current.feature_id);
              if (fresh && fresh.phase.endsWith('ing') && fresh.status === 'succeeded') {
                const gateAdvanced = await checkGateAndAdvance(fresh, bb, sid);
                if (gateAdvanced) {
                  result.featuresAdvanced++;
                  continueWithFeature = true; // gate passed → advance to next phase immediately
                }
              }
            }
            break;
          }
        }
      } catch (err) {
        const errMsg = `Unhandled error: ${err}`;
        result.errors.push({ featureId: current.feature_id, error: errMsg });
        // Reset feature from active to pending so it can be retried
        try {
          const stuck = bb.getFeature(current.feature_id);
          if (stuck?.status === 'active') {
            bb.updateFeature(current.feature_id, {
              status: 'pending',
              current_session: null,
              failure_count: (stuck.failure_count ?? 0) + 1,
              last_error: errMsg,
            });
          }
        } catch {}
        continueWithFeature = false;
      }

      current = continueWithFeature ? (bb.getFeature(feature.feature_id) ?? null) : null;
    }
  }

  return result;
}
