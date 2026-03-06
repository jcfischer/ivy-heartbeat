import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { runSpecflowCli, parseEvalScore } from '../infra/specflow-cli.ts';
import { resolveFeatureDirWithFallback } from '../utils/find-feature-dir.ts';

export const PHASE_EVAL_THRESHOLDS: Record<string, number> = {
  specifying: 80,
  planning: 80,
};

export const PHASE_RUBRICS: Record<string, string> = {
  specifying: 'spec-quality',
  planning: 'plan-quality',
};

export const PHASE_ARTIFACTS: Record<string, string> = {
  specifying: 'spec.md',
  planning: 'plan.md',
};

export interface QualityGateResult {
  passed: boolean;
  score: number;
  reason: string;
}

/**
 * Run the quality gate for a given phase.
 * Runs `specflow eval` on the phase artifact and checks the score.
 *
 * @param worktreePath - Where to look for the artifact (worktree, where agents write)
 * @param phase - Current feature phase (e.g. 'specifying', 'planning')
 * @param featureId - Feature ID
 * @param cliCwd - CWD for the specflow eval CLI (defaults to worktreePath).
 *   Pass the main project path to avoid git-worktree CWD issues with Claude CLI.
 * @param projectPath - Main project path as fallback for artifact resolution.
 *   If the artifact is not found in the worktree, it is looked up here.
 *   Needed when specs were written to the main repo directly (e.g. manual recovery).
 */
export async function checkQualityGate(
  worktreePath: string,
  phase: string,
  featureId: string,
  cliCwd?: string,
  projectPath?: string,
): Promise<QualityGateResult> {
  const rubric = PHASE_RUBRICS[phase];
  const artifact = PHASE_ARTIFACTS[phase];
  const threshold = PHASE_EVAL_THRESHOLDS[phase] ?? 80;

  if (!rubric || !artifact) {
    return { passed: true, score: 100, reason: 'no gate for this phase' };
  }

  const specDir = join(worktreePath, '.specify', 'specs');
  let featureDir = resolveFeatureDirWithFallback(worktreePath, featureId);

  // Fallback: check main project path if artifact not found in worktree
  if (projectPath && projectPath !== worktreePath) {
    const candidateDir = featureDir;
    const candidatePath = candidateDir ? join(candidateDir, artifact) : null;
    if (!candidatePath || !existsSync(candidatePath)) {
      const projectFeatureDir = resolveFeatureDirWithFallback(projectPath, featureId);
      if (projectFeatureDir && existsSync(join(projectFeatureDir, artifact))) {
        featureDir = projectFeatureDir;
      }
    }
  }

  const artifactPath = featureDir
    ? join(featureDir, artifact)
    : join(specDir, featureId, artifact);

  const result = await runSpecflowCli(
    ['eval', 'run', '--file', artifactPath, '--rubric', rubric, '--json'],
    cliCwd ?? worktreePath,
    240_000,
  );

  try {
    const score = parseEvalScore(result.stdout);
    const passed = score >= threshold;
    return {
      passed,
      score,
      reason: passed
        ? `Score ${score} >= threshold ${threshold}`
        : `Score ${score} below threshold ${threshold}`,
    };
  } catch {
    if (result.exitCode !== 0) {
      return { passed: false, score: 0, reason: `Eval failed (exit ${result.exitCode}): ${result.stderr || result.stdout}` };
    }
    return { passed: false, score: 0, reason: `Failed to parse eval output: ${result.stdout}` };
  }
}
