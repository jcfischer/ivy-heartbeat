import { join } from 'node:path';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { Blackboard } from '../../../blackboard.ts';
import type { PhaseExecutor, PhaseExecutorOptions, PhaseResult, SpecFlowFeature } from '../types.ts';
import { runSpecflowCli } from '../infra/specflow-cli.ts';
import { getLauncher } from '../../launcher.ts';

const SPECFLOW_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Base class for phase executors that follow the standard SpecFlow phase execution pattern:
 * 1. Run specflow CLI in prompt-output mode
 * 2. Parse prompt from output file
 * 3. Launch Claude session with full prompt
 * 4. Advance phase in specflow DB
 *
 * Subclasses only need to specify:
 * - phaseName: The specflow phase name (e.g., 'specify', 'plan', 'tasks')
 * - artifactName: The artifact file name (e.g., 'spec.md', 'plan.md', 'tasks.md')
 * - canRun(): Phase eligibility logic
 */
export abstract class BasePhaseExecutor implements PhaseExecutor {
  /** The specflow phase name (e.g., 'specify', 'plan', 'tasks') */
  abstract readonly phaseName: string;

  /** The artifact file name (e.g., 'spec.md', 'plan.md', 'tasks.md') */
  abstract readonly artifactName: string;

  /** Check if this executor can handle the given feature's current phase */
  abstract canRun(feature: SpecFlowFeature): boolean;

  async execute(
    feature: SpecFlowFeature,
    bb: Blackboard,
    opts: PhaseExecutorOptions,
  ): Promise<PhaseResult> {
    const featureId = feature.feature_id;
    const { worktreePath, sessionId } = opts;

    // Step 1: Run specflow in prompt-output mode to get the Claude prompt
    const promptFile = join(worktreePath, '.specflow-prompt.json');
    process.env.SPECFLOW_PROMPT_OUTPUT = promptFile;

    let sfResult: { exitCode: number; stdout: string; stderr: string };
    try {
      sfResult = await runSpecflowCli([this.phaseName, featureId], worktreePath, SPECFLOW_TIMEOUT_MS);
    } finally {
      delete process.env.SPECFLOW_PROMPT_OUTPUT;
    }

    if (sfResult.exitCode !== 0) {
      return {
        status: 'failed',
        error: `specflow ${this.phaseName} exited ${sfResult.exitCode}: ${sfResult.stderr}`
      };
    }

    // If artifact already exists, advance DB and return success
    if (!existsSync(promptFile)) {
      await runSpecflowCli(['phase', featureId, this.phaseName], worktreePath, 10_000);
      return { status: 'succeeded', artifacts: [this.artifactName] };
    }

    // Step 2: Parse the prompt file
    let promptData: { prompt: string; systemPrompt?: string };
    try {
      promptData = JSON.parse(readFileSync(promptFile, 'utf-8'));
    } catch (err) {
      return { status: 'failed', error: `Failed to read prompt file: ${err}` };
    }
    try { unlinkSync(promptFile); } catch {}

    // Step 3: Build the full prompt for Claude
    const fullPrompt = this.buildFullPrompt(promptData);

    // Step 4: Launch Claude session
    bb.appendEvent({
      actorId: sessionId,
      targetId: featureId,
      summary: `Launching Claude for ${this.phaseName} phase of ${featureId}`,
      metadata: { phase: `${this.phaseName}ing`, featureId },
    });

    const launcher = getLauncher();
    const launchResult = await launcher({
      sessionId: `${sessionId}-${this.phaseName}`,
      prompt: fullPrompt,
      workDir: worktreePath,
      timeoutMs: SPECFLOW_TIMEOUT_MS,
    });

    if (launchResult.exitCode !== 0) {
      return {
        status: 'failed',
        error: `Claude launcher exited ${launchResult.exitCode}: ${launchResult.stderr}`
      };
    }

    // Step 5: Advance specflow DB phase
    await runSpecflowCli(['phase', featureId, this.phaseName], worktreePath, 10_000);

    return { status: 'succeeded', artifacts: [this.artifactName] };
  }

  /**
   * Build the full prompt for Claude, combining system context with the main prompt.
   * Subclasses can override this if they need custom prompt formatting.
   */
  protected buildFullPrompt(promptData: { prompt: string; systemPrompt?: string }): string {
    return [
      promptData.systemPrompt ? `[System Context] ${promptData.systemPrompt}` : '',
      'IMPORTANT: You have full tool access. Write the artifact file directly to disk using the Write tool.',
      `After creating the file, output [PHASE COMPLETE: ${this.phaseName.toUpperCase()}] in your response.`,
      '',
      promptData.prompt,
    ].filter(Boolean).join('\n');
  }
}
