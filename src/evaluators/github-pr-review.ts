import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';
import type { BlackboardAccessor } from './github-issues.ts';
import { extractOwnerRepo } from './github-issues.ts';

export interface GithubPR {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  reviews: Array<{ state: string; author: { login: string } }>;
}

interface GithubPrReviewConfig {
  /** Glob pattern for branch names to consider (default "feat/F-*") */
  branchPattern: string;
  /** Skip PRs that already have a review work item in blackboard (default true) */
  skipIfReviewed: boolean;
  /** Max PRs to fetch per repo */
  limit: number;
}

export type PRFetcher = (ownerRepo: string, config: GithubPrReviewConfig) => Promise<GithubPR[]>;

/**
 * Parse config from a checklist item's config fields.
 */
export function parseGithubPrReviewConfig(item: ChecklistItem): GithubPrReviewConfig {
  return {
    branchPattern: typeof item.config.branch_pattern === 'string' ? item.config.branch_pattern : 'feat/F-*',
    skipIfReviewed: typeof item.config.skip_if_reviewed === 'boolean' ? item.config.skip_if_reviewed : true,
    limit: typeof item.config.limit === 'number' ? item.config.limit : 30,
  };
}

/**
 * Check if a branch name matches a glob-like pattern.
 * Supports simple patterns with * as wildcard.
 */
function matchesBranchPattern(branch: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$');
  return regex.test(branch);
}

// ─── Injectable PR fetcher (for testing) ─────────────────────────────────

let prFetcher: PRFetcher = defaultPRFetcher;

async function defaultPRFetcher(ownerRepo: string, config: GithubPrReviewConfig): Promise<GithubPR[]> {
  try {
    const args = [
      'pr', 'list',
      '--repo', ownerRepo,
      '--state', 'open',
      '--json', 'number,title,url,headRefName,reviews',
      '--limit', String(config.limit),
    ];

    const proc = Bun.spawn(['gh', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
      return [];
    }

    return JSON.parse(output) as GithubPR[];
  } catch {
    return [];
  }
}

export function setPRFetcher(fetcher: PRFetcher): void {
  prFetcher = fetcher;
}

export function resetPRFetcher(): void {
  prFetcher = defaultPRFetcher;
}

// ─── Injectable blackboard accessor (for testing) ────────────────────────

let bbAccessor: BlackboardAccessor | null = null;

export function setPrReviewBlackboardAccessor(accessor: BlackboardAccessor): void {
  bbAccessor = accessor;
}

export function resetPrReviewBlackboardAccessor(): void {
  bbAccessor = null;
}

// ─── Evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate GitHub PRs across all registered projects for AI code review.
 *
 * For each project with a remote_repo pointing to GitHub:
 * - Fetches open PRs via gh CLI
 * - Filters to PRs matching the branch pattern (default "feat/F-*")
 * - Compares against existing work items (by source_ref = PR URL)
 * - Creates work items for unreviewed PRs with source: "code_review"
 */
export async function evaluateGithubPrReview(item: ChecklistItem): Promise<CheckResult> {
  if (!bbAccessor) {
    return {
      item,
      status: 'error',
      summary: `GitHub PR review check: ${item.name} — blackboard not configured`,
      details: { error: 'Blackboard accessor not set. Call setPrReviewBlackboardAccessor() before evaluating.' },
    };
  }

  const config = parseGithubPrReviewConfig(item);

  try {
    const projects = bbAccessor.listProjects();
    const githubProjects = projects.filter(
      (p) => p.remote_repo && p.remote_repo.includes('github.com')
    );

    if (githubProjects.length === 0) {
      return {
        item,
        status: 'ok',
        summary: `GitHub PR review check: ${item.name} — no projects with GitHub repos registered`,
        details: { projectsChecked: 0, newReviews: 0 },
      };
    }

    let totalNew = 0;
    const newReviewDetails: Array<{ project: string; pr: string; url: string }> = [];

    for (const project of githubProjects) {
      const ownerRepo = extractOwnerRepo(project.remote_repo!);
      if (!ownerRepo) continue;

      const prs = await prFetcher(ownerRepo, config);
      if (prs.length === 0) continue;

      // Filter to PRs matching the branch pattern
      const matchingPrs = prs.filter((pr) => matchesBranchPattern(pr.headRefName, config.branchPattern));
      if (matchingPrs.length === 0) continue;

      // Get existing work items to check source_ref
      const existingItems = bbAccessor.listWorkItems({
        all: true,
        project: project.project_id,
      });
      const trackedUrls = new Set(
        existingItems
          .map((w) => w.source_ref)
          .filter((ref): ref is string => ref !== null)
      );

      for (const pr of matchingPrs) {
        if (config.skipIfReviewed && trackedUrls.has(pr.url)) continue;

        try {
          bbAccessor.createWorkItem({
            id: `review-${project.project_id}-pr-${pr.number}`,
            title: `Code review: PR #${pr.number} - ${pr.title}`,
            description: `AI code review for PR #${pr.number} in ${ownerRepo}\nBranch: ${pr.headRefName}\nURL: ${pr.url}`,
            project: project.project_id,
            source: 'code_review',
            sourceRef: pr.url,
            priority: 'P1',
            metadata: JSON.stringify({
              pr_number: pr.number,
              repo: ownerRepo,
              branch: pr.headRefName,
              review_status: null,
            }),
          });

          totalNew++;
          newReviewDetails.push({
            project: project.project_id,
            pr: `#${pr.number}: ${pr.title}`,
            url: pr.url,
          });
        } catch {
          // Work item may already exist — skip
        }
      }
    }

    if (totalNew > 0) {
      return {
        item,
        status: 'alert',
        summary: `GitHub PR review check: ${item.name} — ${totalNew} new PR(s) need review across ${githubProjects.length} project(s)`,
        details: {
          projectsChecked: githubProjects.length,
          newReviews: totalNew,
          reviews: newReviewDetails,
        },
      };
    }

    return {
      item,
      status: 'ok',
      summary: `GitHub PR review check: ${item.name} — no new PRs need review across ${githubProjects.length} project(s)`,
      details: {
        projectsChecked: githubProjects.length,
        newReviews: 0,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `GitHub PR review check: ${item.name} — error: ${msg}`,
      details: { error: msg },
    };
  }
}
