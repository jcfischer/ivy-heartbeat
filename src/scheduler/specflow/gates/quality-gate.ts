import { join } from 'node:path';
import { runSpecflowCli, parseEvalScore } from '../infra/specflow-cli.ts';
import { findFeatureDir } from '../utils/find-feature-dir.ts';

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
 */
export async function checkQualityGate(
  worktreePath: string,
  phase: string,
  featureId: string,
): Promise<QualityGateResult> {
  const rubric = PHASE_RUBRICS[phase];
  const artifact = PHASE_ARTIFACTS[phase];
  const threshold = PHASE_EVAL_THRESHOLDS[phase] ?? 80;

  if (!rubric || !artifact) {
    return { passed: true, score: 100, reason: 'no gate for this phase' };
  }

  const specDir = join(worktreePath, '.specify', 'specs');
  const featureDir = findFeatureDir(specDir, featureId);
  const artifactPath = featureDir
    ? join(featureDir, artifact)
    : join(specDir, featureId, artifact);

  const result = await runSpecflowCli(
    ['eval', 'run', '--file', artifactPath, '--rubric', rubric, '--json'],
    worktreePath,
    120_000,
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
