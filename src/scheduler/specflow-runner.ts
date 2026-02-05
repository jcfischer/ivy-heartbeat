/**
 * SpecFlow phase runner.
 *
 * Runs one SpecFlow phase via the specflow CLI, checks quality gates,
 * and chains the next phase by creating a new work item.
 */

import { join } from 'node:path';
import type { Blackboard } from '../blackboard.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';
import {
  type SpecFlowPhase,
  type SpecFlowWorkItemMetadata,
  parseSpecFlowMeta,
  nextPhase,
  PHASE_RUBRICS,
  PHASE_ARTIFACTS,
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

  if (phase === 'specify' && !meta.worktree_path) {
    // First phase: create fresh worktree
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
  const { existsSync } = await import('node:fs');
  const specflowDbPath = join(worktreePath, '.specify', 'specflow.db');
  if (!existsSync(specflowDbPath)) {
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

  // ─── Register GitHub-routed features that don't exist in specflow DB ──
  // GitHub issue features (GH-*) are created by the evaluator, not specflow init.
  // Use `specflow add` to register them, then use the auto-assigned feature ID.
  const originalFeatureId = featureId;
  if (featureId.startsWith('GH-') && phase === 'specify') {
    const featureName = item.title.replace(/^SpecFlow \w+: /, '');
    const featureDesc = item.description ?? featureName;
    const addResult = await spawner(
      ['add', featureName, featureDesc, '--priority', '1'],
      worktreePath,
      30_000
    );
    if (addResult.exitCode === 0) {
      // Parse "Added feature F-019: ..." to get the real specflow ID
      const match = addResult.stdout.match(/Added feature (F-\d+)/);
      if (match) {
        featureId = match[1];
        meta.specflow_feature_id = featureId;
      }
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Registered feature ${originalFeatureId} as ${featureId} in specflow`,
        metadata: { githubFeatureId: originalFeatureId, specflowFeatureId: featureId },
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
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `SpecFlow phase "${phase}" failed (exit ${result.exitCode}) for ${featureId}`,
      metadata: { phase, exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) },
    });
    return false;
  }

  bb.appendEvent({
    actorId: sessionId,
    targetId: item.item_id,
    summary: `SpecFlow phase "${phase}" completed (exit 0) for ${featureId}`,
    metadata: { phase, featureId },
  });

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
      } else {
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Quality gate failed (${gateResult.score}%) — max retries exceeded for ${featureId} phase "${phase}"`,
          metadata: { phase, score: gateResult.score, maxRetries: MAX_RETRIES },
        });
        // Mark as failed — caller will handle the item
      }
      return false;
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
    return { passed: false, score: 0, feedback: `Eval failed: ${result.stderr}` };
  }

  try {
    const evalOutput = JSON.parse(result.stdout);
    const score = evalOutput.score ?? evalOutput.percentage ?? 0;
    const feedback = evalOutput.feedback ?? evalOutput.details ?? result.stdout;
    return {
      passed: score >= QUALITY_THRESHOLD,
      score,
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
    const { readdirSync } = require('node:fs');
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
  };

  bb.createWorkItem({
    id: `specflow-${meta.specflow_feature_id}-${next}`,
    title: `SpecFlow ${next}: ${meta.specflow_feature_id}`,
    description: `SpecFlow phase "${next}" for feature ${meta.specflow_feature_id}`,
    project: meta.specflow_project_id,
    source: 'specflow',
    sourceRef: meta.specflow_feature_id,
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
  };

  bb.createWorkItem({
    id: `specflow-${meta.specflow_feature_id}-${meta.specflow_phase}-retry${retryCount}`,
    title: `SpecFlow ${meta.specflow_phase} (retry ${retryCount}): ${meta.specflow_feature_id}`,
    description: `SpecFlow phase "${meta.specflow_phase}" retry for feature ${meta.specflow_feature_id}\n\nEval feedback:\n${feedback}`,
    project: meta.specflow_project_id,
    source: 'specflow',
    sourceRef: meta.specflow_feature_id,
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
