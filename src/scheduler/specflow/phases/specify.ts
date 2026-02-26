import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { Blackboard } from '../../../blackboard.ts';
import type { PhaseExecutor, PhaseExecutorOptions, PhaseResult, SpecFlowFeature } from '../types.ts';
import { runSpecflowCli } from '../infra/specflow-cli.ts';
import { getLauncher } from '../../launcher.ts';

const SPECFLOW_TIMEOUT_MS = 30 * 60 * 1000;

export class SpecifyExecutor implements PhaseExecutor {
  canRun(feature: SpecFlowFeature): boolean {
    return feature.phase === 'queued' || feature.phase === 'specifying';
  }

  async execute(
    feature: SpecFlowFeature,
    bb: Blackboard,
    opts: PhaseExecutorOptions,
  ): Promise<PhaseResult> {
    const { featureId, worktreePath, sessionId } = this.parseOpts(feature, opts);

    // Step 1: Run specflow in prompt-output mode to get the Claude prompt
    const promptFile = join(worktreePath, '.specflow-prompt.json');
    process.env.SPECFLOW_PROMPT_OUTPUT = promptFile;

    let sfResult: { exitCode: number; stdout: string; stderr: string };
    try {
      sfResult = await runSpecflowCli(['specify', featureId], worktreePath, SPECFLOW_TIMEOUT_MS);
    } finally {
      delete process.env.SPECFLOW_PROMPT_OUTPUT;
    }

    if (sfResult.exitCode !== 0) {
      return { status: 'failed', error: `specflow specify exited ${sfResult.exitCode}: ${sfResult.stderr}` };
    }

    // If artifact already exists, advance DB and return success
    if (!existsSync(promptFile)) {
      await runSpecflowCli(['phase', featureId, 'specify'], worktreePath, 10_000);
      return { status: 'succeeded', artifacts: ['spec.md'] };
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
      'After creating the file, output [PHASE COMPLETE: SPECIFY] in your response.',
      '',
      promptData.prompt,
    ].filter(Boolean).join('\n');

    bb.appendEvent({
      actorId: sessionId,
      targetId: featureId,
      summary: `Launching Claude for specify phase of ${featureId}`,
      metadata: { phase: 'specifying', featureId },
    });

    const launcher = getLauncher();
    const launchResult = await launcher({
      sessionId: `${sessionId}-specify`,
      prompt: fullPrompt,
      workDir: worktreePath,
      timeoutMs: SPECFLOW_TIMEOUT_MS,
    });

    if (launchResult.exitCode !== 0) {
      return { status: 'failed', error: `Claude launcher exited ${launchResult.exitCode}: ${launchResult.stderr}` };
    }

    // Advance specflow DB phase
    await runSpecflowCli(['phase', featureId, 'specify'], worktreePath, 10_000);

    return { status: 'succeeded', artifacts: ['spec.md'] };
  }

  private parseOpts(feature: SpecFlowFeature, opts: PhaseExecutorOptions) {
    return {
      featureId: feature.feature_id,
      worktreePath: opts.worktreePath,
      sessionId: opts.sessionId,
    };
  }
}
