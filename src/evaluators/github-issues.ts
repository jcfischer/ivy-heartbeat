import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';
import type { Blackboard, ProjectWithCounts } from '../blackboard.ts';

export interface GithubIssue {
  number: number;
  title: string;
  url: string;
  state: string;
  labels: Array<{ name: string }>;
  createdAt: string;
  author: { login: string };
  body: string;
}

export interface ContentFilterResult {
  decision: 'ALLOWED' | 'BLOCKED' | 'HUMAN_REVIEW';
  matches: Array<{ pattern_id: string; pattern_name: string; matched_text: string }>;
}

interface GithubIssuesConfig {
  /** Only process issues with these labels (empty = all) */
  labels: string[];
  /** Max issues to fetch per repo */
  limit: number;
  /** GitHub logins treated as owner — issues from these authors run autonomously */
  ownerLogins: string[];
  /** Labels that trigger SpecFlow pipeline on specflow-enabled projects */
  featureRequestLabels: string[];
}

/**
 * Parse config from a checklist item's config fields.
 */
export function parseGithubIssuesConfig(item: ChecklistItem): GithubIssuesConfig {
  return {
    labels: Array.isArray(item.config.labels) ? item.config.labels as string[] : [],
    limit: typeof item.config.limit === 'number' ? item.config.limit : 30,
    ownerLogins: Array.isArray(item.config.owner_logins) ? item.config.owner_logins as string[] : [],
    featureRequestLabels: Array.isArray(item.config.feature_request_labels)
      ? item.config.feature_request_labels as string[]
      : ['feature-request'],
  };
}

/**
 * Check if a project has specflow_enabled in its metadata.
 */
function isSpecFlowEnabled(project: ProjectWithCounts): boolean {
  if (!project.metadata) return false;
  try {
    const meta = JSON.parse(project.metadata);
    return !!meta.specflow_enabled;
  } catch {
    return false;
  }
}

/**
 * Check if an issue has any of the feature-request labels.
 */
function isFeatureRequest(issue: GithubIssue, featureRequestLabels: string[]): boolean {
  if (featureRequestLabels.length === 0) return false;
  const issueLabels = issue.labels.map((l) => l.name.toLowerCase());
  return featureRequestLabels.some((frl) => issueLabels.includes(frl.toLowerCase()));
}

/**
 * Extract owner/repo from a GitHub URL.
 * Handles: https://github.com/owner/repo, https://github.com/owner/repo.git
 */
export function extractOwnerRepo(repoUrl: string): string | null {
  const match = repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return match ? match[1] : null;
}

// ─── Injectable fetcher (for testing) ────────────────────────────────────

export type IssueFetcher = (ownerRepo: string, config: GithubIssuesConfig) => Promise<GithubIssue[]>;

let issueFetcher: IssueFetcher = defaultIssueFetcher;

async function defaultIssueFetcher(ownerRepo: string, config: GithubIssuesConfig): Promise<GithubIssue[]> {
  try {
    const args = [
      'issue', 'list',
      '--repo', ownerRepo,
      '--state', 'open',
      '--limit', String(config.limit),
      '--json', 'number,title,url,state,labels,createdAt,author,body',
    ];

    if (config.labels.length > 0) {
      args.push('--label', config.labels.join(','));
    }

    const proc = Bun.spawn(['gh', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
      return [];
    }

    return JSON.parse(output) as GithubIssue[];
  } catch {
    return [];
  }
}

export function setIssueFetcher(fetcher: IssueFetcher): void {
  issueFetcher = fetcher;
}

export function resetIssueFetcher(): void {
  issueFetcher = defaultIssueFetcher;
}

// ─── Injectable content filter (for testing) ─────────────────────────────

export type ContentFilterFn = (content: string, label: string) => Promise<ContentFilterResult>;

let contentFilter: ContentFilterFn = defaultContentFilter;

async function defaultContentFilter(content: string, label: string): Promise<ContentFilterResult> {
  const filterPath = process.env.CONTENT_FILTER_PATH;
  if (!filterPath) {
    // No content filter configured — fail-open
    return { decision: 'ALLOWED', matches: [] };
  }

  const { join } = await import('node:path');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const tmpDir = mkdtempSync(join(tmpdir(), 'hb-filter-'));
  const tmpFile = join(tmpDir, `${label}.md`);

  try {
    writeFileSync(tmpFile, content);
    const proc = Bun.spawn(
      ['bun', 'run', filterPath, 'check', tmpFile, '--json', '--format', 'markdown'],
      { stdout: 'pipe', stderr: 'pipe' }
    );

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode === 2) {
      // BLOCKED
      const parsed = JSON.parse(output);
      return {
        decision: 'BLOCKED',
        matches: parsed.matches ?? [],
      };
    }

    if (proc.exitCode === 0) {
      try {
        const parsed = JSON.parse(output);
        return {
          decision: parsed.decision ?? 'ALLOWED',
          matches: parsed.matches ?? [],
        };
      } catch {
        return { decision: 'ALLOWED', matches: [] };
      }
    }

    // Fail-open on unexpected exit codes
    return { decision: 'ALLOWED', matches: [] };
  } catch {
    // Fail-open: content filter errors should not block issue processing
    return { decision: 'ALLOWED', matches: [] };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function setContentFilter(filter: ContentFilterFn): void {
  contentFilter = filter;
}

export function resetContentFilter(): void {
  contentFilter = defaultContentFilter;
}

// ─── Blackboard accessor (injectable for testing) ────────────────────────

export type BlackboardAccessor = {
  listProjects(): ProjectWithCounts[];
  listWorkItems(opts?: { all?: boolean; project?: string }): Array<{
    source_ref: string | null;
    metadata?: string | null;
    status?: string;
  }>;
  createWorkItem(opts: {
    id: string;
    title: string;
    description?: string;
    project?: string | null;
    source?: string;
    sourceRef?: string;
    priority?: string;
    metadata?: string;
  }): unknown;
  updateWorkItemMetadata(itemId: string, updates: Record<string, unknown>): unknown;
};

let bbAccessor: BlackboardAccessor | null = null;

export function setBlackboardAccessor(accessor: BlackboardAccessor): void {
  bbAccessor = accessor;
}

export function resetBlackboardAccessor(): void {
  bbAccessor = null;
}

/**
 * Evaluate GitHub issues across all registered projects.
 *
 * For each project with a remote_repo pointing to GitHub:
 * - Fetches open issues via gh CLI
 * - Compares against existing work items (by source_ref = issue URL)
 * - Creates work items for new issues with human-gated fix workflow
 */
export async function evaluateGithubIssues(item: ChecklistItem): Promise<CheckResult> {
  if (!bbAccessor) {
    return {
      item,
      status: 'error',
      summary: `GitHub issues check: ${item.name} — blackboard not configured`,
      details: { error: 'Blackboard accessor not set. Call setBlackboardAccessor() before evaluating.' },
    };
  }

  const config = parseGithubIssuesConfig(item);

  try {
    const projects = bbAccessor.listProjects();
    const githubProjects = projects.filter(
      (p) => p.remote_repo && p.remote_repo.includes('github.com')
    );

    if (githubProjects.length === 0) {
      return {
        item,
        status: 'ok',
        summary: `GitHub issues check: ${item.name} — no projects with GitHub repos registered`,
        details: { projectsChecked: 0, newIssues: 0 },
      };
    }

    let totalNew = 0;
    const newIssueDetails: Array<{ project: string; issue: string; url: string }> = [];

    for (const project of githubProjects) {
      const ownerRepo = extractOwnerRepo(project.remote_repo!);
      if (!ownerRepo) continue;

      const issues = await issueFetcher(ownerRepo, config);
      if (issues.length === 0) continue;

      // Get existing work items for this project to check source_ref
      const existingItems = bbAccessor.listWorkItems({
        all: true,
        project: project.project_id,
      });
      const trackedUrls = new Set(
        existingItems
          .map((w) => w.source_ref)
          .filter((ref): ref is string => ref !== null)
      );
      // Also check metadata for specflow items tracking GitHub issues
      const trackedIssueUrls = new Set(
        existingItems
          .filter((w) => w.metadata)
          .map((w) => {
            try {
              const m = JSON.parse(w.metadata!);
              return m.github_issue_url as string | undefined;
            } catch { return undefined; }
          })
          .filter((url): url is string => !!url)
      );

      for (const issue of issues) {
        if (trackedUrls.has(issue.url) || trackedIssueUrls.has(issue.url)) continue;

        // New issue — filter content before creating work item
        const labelStr = issue.labels.map((l) => l.name).join(', ');

        // Run issue body through content filter to detect prompt injection
        let filterResult: ContentFilterResult;
        try {
          filterResult = await contentFilter(
            issue.body ?? '',
            `issue-${ownerRepo.replace('/', '-')}-${issue.number}`
          );
        } catch {
          // Fail-open: if the content filter itself errors, allow the content
          filterResult = { decision: 'ALLOWED', matches: [] };
        }
        // Only hard-block when injection patterns matched (not encoding-only false positives)
        const hasPatternMatches = filterResult.matches.length > 0;
        const contentBlocked = filterResult.decision === 'BLOCKED' && hasPatternMatches;
        const contentWarning = filterResult.decision === 'BLOCKED' && !hasPatternMatches;

        // ─── Route feature requests to SpecFlow on enabled projects ─────
        const routeToSpecFlow = isFeatureRequest(issue, config.featureRequestLabels)
          && isSpecFlowEnabled(project);

        if (routeToSpecFlow) {
          const featureId = `GH-${issue.number}`;
          const sfItemId = `specflow-${featureId}-specify`;

          const sfDescParts = [
            `GitHub Issue #${issue.number}: ${issue.title}`,
            `Repository: ${ownerRepo}`,
            `Opened by: ${issue.author.login}`,
            labelStr ? `Labels: ${labelStr}` : '',
            `URL: ${issue.url}`,
          ];

          if (contentBlocked) {
            sfDescParts.push(
              '',
              '## ⚠ Content Blocked',
              'Issue body was blocked by content filter (prompt injection detected).',
              `Matched patterns: ${filterResult.matches.map((m) => m.pattern_id).join(', ')}`,
              'Review the issue manually before acting on it.',
            );
          } else if (issue.body) {
            if (contentWarning) {
              sfDescParts.push(
                '',
                '## ⚠ Content Warning',
                'Content filter flagged encoding anomalies (no injection patterns matched). Body included for review.',
              );
            }
            sfDescParts.push(
              '',
              '## Issue Details',
              issue.body,
            );
          }

          const sfMetadata = {
            specflow_feature_id: featureId,
            specflow_phase: 'specify',
            specflow_project_id: project.project_id,
            github_issue_number: issue.number,
            github_issue_url: issue.url,
            github_repo: ownerRepo,
            content_filtered: true,
            content_blocked: contentBlocked,
          };

          try {
            bbAccessor.createWorkItem({
              id: sfItemId,
              title: `SpecFlow specify: ${featureId}`,
              description: sfDescParts.filter(Boolean).join('\n'),
              project: project.project_id,
              source: 'specflow',
              sourceRef: issue.url,
              priority: 'P2',
              metadata: JSON.stringify(sfMetadata),
            });

            totalNew++;
            newIssueDetails.push({
              project: project.project_id,
              issue: `#${issue.number}: ${issue.title} (→ SpecFlow)`,
              url: issue.url,
            });
          } catch (sfErr: unknown) {
            const sfErrMsg = sfErr instanceof Error ? sfErr.message : String(sfErr);

            if (sfErrMsg.includes('Content blocked') || sfErrMsg.includes('CONTENT_BLOCKED')) {
              const strippedSfDesc = [
                `GitHub Issue #${issue.number}: ${issue.title}`,
                `Repository: ${ownerRepo}`,
                `Opened by: ${issue.author.login}`,
                labelStr ? `Labels: ${labelStr}` : '',
                `URL: ${issue.url}`,
                '',
                '## ⚠ Body Omitted',
                'Issue body was blocked by blackboard ingestion filter.',
                'Read the full issue on GitHub.',
              ].filter(Boolean).join('\n');

              try {
                bbAccessor.createWorkItem({
                  id: sfItemId,
                  title: `SpecFlow specify: ${featureId}`,
                  description: strippedSfDesc,
                  project: project.project_id,
                  source: 'specflow',
                  sourceRef: issue.url,
                  priority: 'P2',
                  metadata: JSON.stringify({
                    ...sfMetadata,
                    human_review_required: true,
                    body_stripped_by_ingestion_filter: true,
                  }),
                });

                totalNew++;
                newIssueDetails.push({
                  project: project.project_id,
                  issue: `#${issue.number}: ${issue.title} (→ SpecFlow, body stripped)`,
                  url: issue.url,
                });
              } catch { /* truly duplicate or other unrecoverable error */ }
            } else {
              // Work item already exists — backfill metadata if missing
              try {
                const existing = existingItems.find((i) => i.source_ref === issue.url);
                if (existing && !existing.metadata) {
                  bbAccessor.updateWorkItemMetadata(sfItemId, sfMetadata);
                }
              } catch { /* best effort metadata backfill */ }
            }
          }
          continue;
        }

        // ─── Regular GitHub work item ───────────────────────────────
        const itemId = `gh-${project.project_id}-${issue.number}`;
        const isOwner = config.ownerLogins.some(
          (login) => login.toLowerCase() === issue.author.login.toLowerCase()
        );

        const descriptionParts = [
          `GitHub Issue #${issue.number}: ${issue.title}`,
          `Repository: ${ownerRepo}`,
          `Opened by: ${issue.author.login}${isOwner ? ' (owner — autonomous execution)' : ''}`,
          labelStr ? `Labels: ${labelStr}` : '',
          `URL: ${issue.url}`,
        ];

        if (contentBlocked) {
          descriptionParts.push(
            '',
            '## ⚠ Content Blocked',
            'Issue body was blocked by content filter (prompt injection detected).',
            `Matched patterns: ${filterResult.matches.map((m) => m.pattern_id).join(', ')}`,
            'Review the issue manually before acting on it.',
          );
        } else if (issue.body) {
          if (contentWarning) {
            descriptionParts.push(
              '',
              '## ⚠ Content Warning',
              'Content filter flagged encoding anomalies (no injection patterns matched). Body included for review.',
            );
          }
          descriptionParts.push(
            '',
            '## Issue Details',
            issue.body,
          );
        }

        const description = descriptionParts.filter(Boolean).join('\n');

        const workItemMetadata = {
          github_issue_number: issue.number,
          github_repo: ownerRepo,
          author: issue.author.login,
          labels: issue.labels.map((l) => l.name),
          workflow: isOwner ? 'investigate-branch-implement-test-commit-push-comment' : 'acknowledge-investigate-branch-implement-test-commit-push-comment',
          human_review_required: !isOwner,
          content_filtered: true,
          content_blocked: contentBlocked,
          content_warning: contentWarning,
          filter_matches: filterResult.matches.map((m) => m.pattern_id),
        };

        try {
          bbAccessor.createWorkItem({
            id: itemId,
            title: `Issue #${issue.number}: ${issue.title}`,
            description,
            project: project.project_id,
            source: 'github',
            sourceRef: issue.url,
            priority: isOwner ? 'P1' : 'P2',
            metadata: JSON.stringify(workItemMetadata),
          });

          totalNew++;
          newIssueDetails.push({
            project: project.project_id,
            issue: `#${issue.number}: ${issue.title}`,
            url: issue.url,
          });
        } catch (createErr: unknown) {
          const errMsg = createErr instanceof Error ? createErr.message : String(createErr);

          // Blackboard's defense-in-depth content filter blocked the issue body.
          // Retry with a stripped description (metadata only, no body) so the work
          // item is still tracked. The operator can read the full body on GitHub.
          if (errMsg.includes('Content blocked') || errMsg.includes('CONTENT_BLOCKED')) {
            const strippedDesc = [
              `GitHub Issue #${issue.number}: ${issue.title}`,
              `Repository: ${ownerRepo}`,
              `Opened by: ${issue.author.login}${isOwner ? ' (owner — autonomous execution)' : ''}`,
              labelStr ? `Labels: ${labelStr}` : '',
              `URL: ${issue.url}`,
              '',
              '## ⚠ Body Omitted',
              'Issue body was blocked by blackboard ingestion filter.',
              'Read the full issue on GitHub.',
            ].filter(Boolean).join('\n');

            try {
              bbAccessor.createWorkItem({
                id: itemId,
                title: `Issue #${issue.number}: ${issue.title}`,
                description: strippedDesc,
                project: project.project_id,
                source: 'github',
                sourceRef: issue.url,
                priority: isOwner ? 'P1' : 'P2',
                metadata: JSON.stringify({
                  ...workItemMetadata,
                  human_review_required: true,
                  body_stripped_by_ingestion_filter: true,
                }),
              });

              totalNew++;
              newIssueDetails.push({
                project: project.project_id,
                issue: `#${issue.number}: ${issue.title} (body stripped)`,
                url: issue.url,
              });
            } catch { /* truly duplicate or other unrecoverable error */ }
          } else {
            // Work item already exists — backfill metadata if missing
            try {
              const existing = existingItems.find((i) => i.source_ref === issue.url);
              if (existing && !existing.metadata) {
                bbAccessor.updateWorkItemMetadata(itemId, workItemMetadata);
              }
            } catch { /* best effort metadata backfill */ }
          }
        }
      }
    }

    if (totalNew > 0) {
      return {
        item,
        status: 'alert',
        summary: `GitHub issues check: ${item.name} — ${totalNew} new issue(s) found across ${githubProjects.length} project(s)`,
        details: {
          projectsChecked: githubProjects.length,
          newIssues: totalNew,
          issues: newIssueDetails,
        },
      };
    }

    return {
      item,
      status: 'ok',
      summary: `GitHub issues check: ${item.name} — no new issues across ${githubProjects.length} project(s)`,
      details: {
        projectsChecked: githubProjects.length,
        newIssues: 0,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `GitHub issues check: ${item.name} — error: ${msg}`,
      details: { error: msg },
    };
  }
}
