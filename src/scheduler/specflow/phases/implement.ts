import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Database } from 'bun:sqlite';
import type { Blackboard } from '../../../blackboard.ts';
import type { PhaseExecutor, PhaseExecutorOptions, PhaseResult, SpecFlowFeature } from '../types.ts';
import { getLauncher } from '../../launcher.ts';
import { commitAll } from '../infra/worktree.ts';
import { resolveFeatureDirWithFallback } from '../utils/find-feature-dir.ts';
import { queryLessons } from '../../../reflect/analyzer.ts';

const IMPLEMENT_TIMEOUT_MIN_MS = 30 * 60 * 1000;
const IMPLEMENT_TIMEOUT_PER_TASK_MS = 3 * 60 * 1000;
const CODING_PREAMBLE = `EXECUTION MODE: Direct Implementation

You are in coding-only mode. Do NOT use PAI Algorithm format, ISC creation, capability audits, or voice notification curls. Skip all OBSERVE/THINK/PLAN phases. Go directly to writing code.

Your ONLY job: implement the feature as specified in the tasks.md file. Write code, run tests, commit.

`;

function buildLessonsSection(db: Database, project: string): string {
  const lessons = queryLessons(db, { project, limit: 20 });
  if (lessons.length === 0) return '';

  const byCategory = new Map<string, string[]>();
  for (const lesson of lessons) {
    const constraints = byCategory.get(lesson.category) ?? [];
    constraints.push(`  - [${lesson.severity}] ${lesson.constraint}`);
    byCategory.set(lesson.category, constraints);
  }

  const lines = ['## Known Constraints from Prior Implementations', ''];
  for (const [category, constraints] of byCategory) {
    lines.push(`### ${category}`);
    lines.push(...constraints);
    lines.push('');
  }
  lines.push('Apply these constraints as you implement. They reflect real issues from past cycles.\n');
  return lines.join('\n');
}

function buildImplementPrompt(featureId: string, specDir: string, db: Database, project: string): string {
  const parts: string[] = [CODING_PREAMBLE];

  const lessonsSection = buildLessonsSection(db, project);
  if (lessonsSection) parts.push(lessonsSection);

  parts.push(`Implement SpecFlow feature: ${featureId}\n`);

  for (const file of ['spec.md', 'plan.md', 'tasks.md']) {
    const path = join(specDir, file);
    if (existsSync(path)) {
      try {
        parts.push(`## ${file}\n${readFileSync(path, 'utf-8')}\n`);
      } catch {}
    }
  }

  parts.push('\nImplement ALL tasks from tasks.md. Run `bun test` when done. Do not ask for confirmation.');
  return parts.join('\n');
}

function countTasks(specDir: string): number {
  const tasksPath = join(specDir, 'tasks.md');
  if (!existsSync(tasksPath)) return 0;
  try {
    const content = readFileSync(tasksPath, 'utf-8');
    return (content.match(/^### T-/gm) ?? []).length;
  } catch {
    return 0;
  }
}

export class ImplementExecutor implements PhaseExecutor {
  canRun(feature: SpecFlowFeature): boolean {
    return feature.phase === 'tasked' || feature.phase === 'implementing';
  }

  async execute(
    feature: SpecFlowFeature,
    bb: Blackboard,
    opts: PhaseExecutorOptions,
  ): Promise<PhaseResult> {
    const featureId = feature.feature_id;
    const { worktreePath, sessionId } = opts;

    const specRoot = join(worktreePath, '.specify', 'specs');
    const featureDir = resolveFeatureDirWithFallback(worktreePath, featureId) ?? join(specRoot, featureId);
    const taskCount = countTasks(featureDir);
    const timeoutMs = Math.max(IMPLEMENT_TIMEOUT_MIN_MS, taskCount * IMPLEMENT_TIMEOUT_PER_TASK_MS);

    const project = feature.project_id ?? feature.github_repo ?? '';
    const prompt = buildImplementPrompt(featureId, featureDir, opts.db, project);

    bb.appendEvent({
      actorId: sessionId,
      targetId: featureId,
      summary: `Launching Claude for implement phase of ${featureId} (${taskCount} tasks, ${Math.round(timeoutMs / 60_000)}min timeout)`,
      metadata: { phase: 'implementing', featureId, taskCount, timeoutMs },
    });

    const launcher = getLauncher();
    const launchResult = await launcher({
      sessionId: `${sessionId}-implement`,
      prompt,
      workDir: worktreePath,
      timeoutMs,
    });

    // Always commit whatever the agent wrote, regardless of exit code.
    // This ensures timed-out or killed agents don't lose their partial work.
    const sha = await commitAll(worktreePath, `feat(specflow): ${featureId} implementation`);
    if (sha) {
      bb.appendEvent({
        actorId: sessionId,
        targetId: featureId,
        summary: `Committed implementation changes for ${featureId}`,
        metadata: { featureId, commitSha: sha },
      });
    }

    if (launchResult.exitCode !== 0) {
      return { status: 'failed', error: `Implement agent exited ${launchResult.exitCode}: ${launchResult.stderr}` };
    }

    return { status: 'succeeded', sourceChanges: true };
  }
}
