import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { Blackboard } from '../../../blackboard.ts';
import type { PhaseExecutor, PhaseExecutorOptions, PhaseResult, SpecFlowFeature } from '../types.ts';
import { runSpecflowCli } from '../infra/specflow-cli.ts';
import { getLauncher } from '../../launcher.ts';

const SPECFLOW_TIMEOUT_MS = 30 * 60 * 1000;

export class PlanExecutor implements PhaseExecutor {
  canRun(feature: SpecFlowFeature): boolean {
    return feature.phase === 'specified' || feature.phase === 'planning';
  }

  async execute(
    feature: SpecFlowFeature,
    bb: Blackboard,
    opts: PhaseExecutorOptions,
  ): Promise<PhaseResult> {
    const featureId = feature.feature_id;
    const { worktreePath, sessionId } = opts;

    const promptFile = join(worktreePath, '.specflow-prompt.json');
    process.env.SPECFLOW_PROMPT_OUTPUT = promptFile;

    let sfResult: { exitCode: number; stdout: string; stderr: string };
    try {
      sfResult = await runSpecflowCli(['plan', featureId], worktreePath, SPECFLOW_TIMEOUT_MS);
    } finally {
      delete process.env.SPECFLOW_PROMPT_OUTPUT;
    }

    if (sfResult.exitCode !== 0) {
      return { status: 'failed', error: `specflow plan exited ${sfResult.exitCode}: ${sfResult.stderr}` };
    }

    if (!existsSync(promptFile)) {
      await runSpecflowCli(['phase', featureId, 'plan'], worktreePath, 10_000);
      return { status: 'succeeded', artifacts: ['plan.md'] };
    }

    let promptData: { prompt: string; systemPrompt?: string };
    try {
      promptData = JSON.parse(readFileSync(promptFile, 'utf-8'));
    } catch (err) {
      return { status: 'failed', error: `Failed to read prompt file: ${err}` };
    }
    try { unlinkSync(promptFile); } catch {}

    const fullPrompt = [
      promptData.systemPrompt ? `[System Context] ${promptData.systemPrompt}` : '',
      'IMPORTANT: You have full tool access. Write the artifact file directly to disk using the Write tool.',
      'After creating the file, output [PHASE COMPLETE: PLAN] in your response.',
      '',
      promptData.prompt,
    ].filter(Boolean).join('\n');

    bb.appendEvent({
      actorId: sessionId,
      targetId: featureId,
      summary: `Launching Claude for plan phase of ${featureId}`,
      metadata: { phase: 'planning', featureId },
    });

    const launcher = getLauncher();
    const launchResult = await launcher({
      sessionId: `${sessionId}-plan`,
      prompt: fullPrompt,
      workDir: worktreePath,
      timeoutMs: SPECFLOW_TIMEOUT_MS,
    });

    if (launchResult.exitCode !== 0) {
      return { status: 'failed', error: `Claude launcher exited ${launchResult.exitCode}: ${launchResult.stderr}` };
    }

    await runSpecflowCli(['phase', featureId, 'plan'], worktreePath, 10_000);

    return { status: 'succeeded', artifacts: ['plan.md'] };
  }
}
