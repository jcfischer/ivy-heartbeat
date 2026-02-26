import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Blackboard } from '../../../blackboard.ts';
import type { PhaseExecutor, PhaseExecutorOptions, PhaseResult, SpecFlowFeature } from '../types.ts';
import { runSpecflowCli } from '../infra/specflow-cli.ts';
import {
  commitAll,
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

const SPECFLOW_TIMEOUT_MS = 30 * 60 * 1000;

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

    // Run specflow complete (generates docs.md, verify.md, etc.)
    const sfResult = await runSpecflowCli(
      ['complete', featureId],
      worktreePath,
      SPECFLOW_TIMEOUT_MS,
    );
    if (sfResult.exitCode !== 0) {
      return { status: 'failed', error: `specflow complete exited ${sfResult.exitCode}: ${sfResult.stderr}` };
    }

    // Commit any completion artifacts
    const sha = await commitAll(worktreePath, `chore(specflow): ${featureId} completion artifacts`);
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

    // Build PR body from spec artifacts
    const specDir = join(worktreePath, '.specify', 'specs');
    const featureDir = this.findFeatureDir(specDir, featureId);
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

    // Create code review work item
    const repo = feature.github_repo;
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

  private findFeatureDir(specDir: string, featureId: string): string | null {
    try {
      const { readdirSync } = require('node:fs');
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
