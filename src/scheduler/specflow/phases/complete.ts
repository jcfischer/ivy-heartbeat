import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Blackboard } from '../../../blackboard.ts';
import type { PhaseExecutor, PhaseExecutorOptions, PhaseResult, SpecFlowFeature } from '../types.ts';
import { runSpecflowCli } from '../infra/specflow-cli.ts';
import { getLauncher } from '../../launcher.ts';
import { extractOwnerRepo } from '../../../evaluators/github-issues.ts';
import {
  commitFiles,
  pushBranch,
  createPR,
  getCurrentBranch,
  hasCommitsAhead,
  removeWorktree,
} from '../infra/worktree.ts';
import {
  extractProblemStatement,
  extractKeyDecisions,
  getFilesChangedSummary,
  formatFilesChanged,
} from '../../../lib/pr-body-extractor.ts';
import { findFeatureDir } from '../utils/find-feature-dir.ts';

const SPECFLOW_TIMEOUT_MS = 30 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

const VERIFY_PREAMBLE = `EXECUTION MODE: Verification Documentation

You are writing a verify.md document. Do NOT use PAI Algorithm format, ISC creation, or voice notification curls. Go directly to writing the document.

Your ONLY job: write a verify.md that documents end-to-end verification of this feature.

`;

function buildVerifyPrompt(featureId: string, specDir: string): string {
  const parts: string[] = [VERIFY_PREAMBLE];
  parts.push(`Write verify.md for SpecFlow feature: ${featureId}\n`);

  for (const file of ['spec.md', 'plan.md', 'tasks.md']) {
    const path = join(specDir, file);
    if (existsSync(path)) {
      try {
        parts.push(`## ${file}\n${readFileSync(path, 'utf-8')}\n`);
      } catch {}
    }
  }

  parts.push(`
Write verify.md at: ${join(specDir, 'verify.md')}

The document must:
1. Have a header: "# ${featureId} Verification Report: [feature title from spec.md]"
2. Check each functional requirement from spec.md and mark PASS/FAIL based on the actual implementation
3. Include smoke test results by running \`bun test\` and reporting the output
4. Include an API Verification section if the feature adds HTTP endpoints
5. End with "## Final Verdict" — PASS or FAIL with reasoning

Run \`bun test\` to get actual test results. Look at the actual source files to verify each FR was implemented.
Write the file directly using the Write tool. Do not ask for confirmation.
`);

  return parts.join('\n');
}

export class CompleteExecutor implements PhaseExecutor {
  canRun(feature: SpecFlowFeature): boolean {
    return feature.phase === 'implemented' || feature.phase === 'completing';
  }

  async execute(
    feature: SpecFlowFeature,
    bb: Blackboard,
    opts: PhaseExecutorOptions,
  ): Promise<PhaseResult> {
    const featureId = feature.feature_id;
    const { worktreePath, projectPath, sessionId } = opts;
    const mainBranch = feature.main_branch ?? 'main';

    // Generate verify.md if missing — specflow complete requires it
    const specRoot = join(worktreePath, '.specify', 'specs');
    const featureDir = findFeatureDir(specRoot, featureId);
    const verifyPath = featureDir ? join(featureDir, 'verify.md') : null;
    if (verifyPath && !existsSync(verifyPath)) {
      await this.generateVerifyMd(featureId, featureDir!, bb, sessionId, worktreePath);
    }

    // Run specflow complete (generates docs.md, validates verify.md, runs Doctorow gate)
    const sfResult = await runSpecflowCli(
      ['complete', featureId],
      worktreePath,
      SPECFLOW_TIMEOUT_MS,
    );
    if (sfResult.exitCode !== 0) {
      return { status: 'failed', error: `specflow complete exited ${sfResult.exitCode}: ${sfResult.stderr}` };
    }

    // Commit completion artifacts — target only known output files to avoid
    // staging untracked .specify/ spec files that may contain personal paths
    // and trip gitleaks pre-commit hooks.
    const artifactFiles = ['CHANGELOG.md'];
    if (featureDir) {
      // featureDir is absolute; compute relative path for git add
      const relDir = featureDir.slice(worktreePath.length).replace(/^\//, '');
      artifactFiles.push(join(relDir, 'docs.md'));
      artifactFiles.push(join(relDir, 'verify.md'));
    }
    const sha = await commitFiles(worktreePath, artifactFiles, `chore(specflow): ${featureId} completion artifacts`);
    if (sha) {
      bb.appendEvent({
        actorId: sessionId,
        targetId: featureId,
        summary: `Committed completion artifacts for ${featureId}`,
        metadata: { featureId, commitSha: sha },
      });
    }

    const branch = await getCurrentBranch(worktreePath);
    const hasCommits = await hasCommitsAhead(worktreePath, mainBranch);
    if (!hasCommits) {
      return { status: 'succeeded', metadata: { skippedPR: true, reason: 'no commits ahead of main' } };
    }

    await pushBranch(worktreePath, branch);

    // Build PR body from spec artifacts (reuse featureDir found earlier)
    const prBody = await this.buildPrBody(featureId, featureDir, mainBranch, branch);

    const pr = await createPR(
      worktreePath,
      `feat(specflow): ${featureId} ${feature.title}`,
      prBody,
      mainBranch,
      branch,
    );

    bb.appendEvent({
      actorId: sessionId,
      targetId: featureId,
      summary: `Created PR #${pr.number} for ${featureId}`,
      metadata: { prNumber: pr.number, prUrl: pr.url, branch },
    });

    // Create code review work item — resolve repo from feature record or project remote_repo
    const repo = feature.github_repo
      ?? extractOwnerRepo(bb.getProject(feature.project_id)?.remote_repo ?? '');
    if (repo) {
      this.createReviewWorkItem(bb, featureId, feature.project_id, pr, branch, mainBranch, repo);
    }

    // Clean up worktree
    try {
      await removeWorktree(projectPath, worktreePath);
    } catch {}

    return {
      status: 'succeeded',
      metadata: { prNumber: pr.number, prUrl: pr.url, commitSha: sha ?? undefined },
    };
  }

  private async generateVerifyMd(
    featureId: string,
    featureDir: string,
    bb: Blackboard,
    sessionId: string,
    worktreePath: string,
  ): Promise<void> {
    const prompt = buildVerifyPrompt(featureId, featureDir);
    bb.appendEvent({
      actorId: sessionId,
      targetId: featureId,
      summary: `Generating verify.md for ${featureId}`,
      metadata: { phase: 'completing', featureId },
    });

    const launcher = getLauncher();
    await launcher({
      sessionId: `${sessionId}-verify`,
      prompt,
      workDir: worktreePath,
      timeoutMs: VERIFY_TIMEOUT_MS,
    });
    // Continue regardless of exit code — specflow complete will validate
  }

  private async buildPrBody(featureId: string, featureDir: string | null, mainBranch: string, branch: string): Promise<string> {
    let summary = 'See spec.md for full feature details';
    let approach: string[] = ['See plan.md for implementation details'];
    try {
      const specPath = featureDir ? join(featureDir, 'spec.md') : null;
      if (specPath && existsSync(specPath)) {
        summary = extractProblemStatement(await Bun.file(specPath).text());
      }
      const planPath = featureDir ? join(featureDir, 'plan.md') : null;
      if (planPath && existsSync(planPath)) {
        approach = extractKeyDecisions(await Bun.file(planPath).text());
      }
    } catch {}

    const filesChanged = await getFilesChangedSummary(mainBranch, branch);
    let body = [`# Feature: ${featureId}`, '', '## Summary', '', summary, '', '## Implementation Approach', '', ...approach.map(p => `- ${p}`), '', '## Files Changed', '', formatFilesChanged(filesChanged)].join('\n');
    if (body.length > 4000) body = body.slice(0, 3997) + '...';
    return body;
  }

  private createReviewWorkItem(
    bb: Blackboard,
    featureId: string,
    projectId: string,
    pr: { number: number; url: string },
    branch: string,
    mainBranch: string,
    repo: string,
  ): void {
    try {
      bb.createWorkItem({
        id: `review-${projectId}-pr-${pr.number}`,
        title: `Code review: PR #${pr.number} - ${featureId}`,
        description: `AI code review for SpecFlow feature PR #${pr.number}\nFeature: ${featureId}`,
        project: projectId,
        source: 'code_review',
        sourceRef: pr.url,
        priority: 'P1',
        metadata: JSON.stringify({
          pr_number: pr.number,
          pr_url: pr.url,
          repo,
          branch,
          main_branch: mainBranch,
          review_status: null,
        }),
      });
    } catch {}
  }
}
