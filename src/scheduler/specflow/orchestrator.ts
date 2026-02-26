import { join } from 'node:path';
import { existsSync } from 'node:fs';
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

const EXECUTORS: PhaseExecutor[] = [
  new SpecifyExecutor(),
  new PlanExecutor(),
  new TasksExecutor(),
  new ImplementExecutor(),
  new CompleteExecutor(),
];

const DEFAULT_PHASE_TIMEOUT_MIN = 90;

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
    if (isStale(feature.phase_started_at, timeoutMin)) {
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
 * Set up or reuse a worktree for a feature. Returns the worktree path.
 */
async function setupWorktree(
  feature: SpecFlowFeature,
  projectPath: string,
): Promise<string> {
  const branch = `specflow-${feature.feature_id.toLowerCase()}`;
  if (feature.worktree_path) {
    return ensureWorktree(projectPath, feature.worktree_path, branch);
  }
  // createWorktree computes the path from IVY_WORKTREE_DIR and returns it
  return createWorktree(projectPath, branch, feature.project_id);
}

/**
 * Find the feature directory under .specify/specs/.
 */
function findFeatureSpecDir(worktreePath: string, featureId: string): string | null {
  try {
    const { readdirSync } = require('node:fs');
    const specDir = join(worktreePath, '.specify', 'specs');
    const entries = readdirSync(specDir, { withFileTypes: true });
    const prefix = featureId.toLowerCase();
    for (const e of entries) {
      if (e.isDirectory && e.name.toLowerCase().startsWith(prefix)) {
        return join(specDir, e.name);
      }
    }
  } catch {}
  return null;
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
    const featureDir = findFeatureSpecDir(worktreePath, feature.feature_id);
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
    const action = determineAction(feature, config.phaseTimeoutMin);

    try {
      switch (action.type) {
        case 'wait':
          break;

        case 'release':
          // Shouldn't happen after first pass, but handle defensively
          bb.updateFeature(feature.feature_id, {
            status: 'pending',
            current_session: null,
            last_error: action.reason,
          });
          result.featuresReleased++;
          break;

        case 'fail':
          bb.updateFeature(feature.feature_id, {
            phase: 'failed',
            status: 'failed',
            last_error: action.reason,
          });
          bb.appendEvent({
            actorId: sid,
            targetId: feature.feature_id,
            summary: `Feature ${feature.feature_id} marked failed: ${action.reason}`,
            metadata: { featureId: feature.feature_id, reason: action.reason },
          });
          result.featuresFailed++;
          break;

        case 'advance':
          bb.updateFeature(feature.feature_id, {
            phase: action.toPhase as SpecFlowFeature['phase'],
            status: 'pending',
          });
          bb.appendEvent({
            actorId: sid,
            targetId: feature.feature_id,
            summary: `Advanced ${feature.feature_id}: ${action.fromPhase} → ${action.toPhase}`,
            metadata: { fromPhase: action.fromPhase, toPhase: action.toPhase },
          });
          result.featuresAdvanced++;
          break;

        case 'check-gate': {
          const gateAdvanced = await checkGateAndAdvance(feature, bb, sid);
          if (gateAdvanced) result.featuresAdvanced++;
          break;
        }

        case 'run-phase': {
          const phaseRes = await runPhase(feature, bb, config, sid);
          if (phaseRes.failed) {
            result.featuresFailed++;
            if (phaseRes.error) {
              result.errors.push({ featureId: feature.feature_id, error: phaseRes.error });
            }
          }
          break;
        }
      }
    } catch (err) {
      result.errors.push({
        featureId: feature.feature_id,
        error: `Unhandled error: ${err}`,
      });
    }
  }

  return result;
}
