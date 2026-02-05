import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';
import type { Blackboard } from '../blackboard.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WatchedIssueStatus {
  number: number;
  state: string;
  comments: Array<{
    author: { login: string };
    body: string;
    createdAt: string;
  }>;
}

export interface WaitingMetadata {
  waiting_type: string;
  watched_repo: string;
  watched_issue: number;
  watched_since: string;
  last_checked_at: string;
  originating_item_id: string;
  originating_project: string;
  resume_context: string;
  on_close: string;
  on_comment: string;
}

// ─── Injectable issue status fetcher (for testing) ──────────────────────────

export type IssueStatusFetcher = (
  ownerRepo: string,
  issueNumber: number
) => Promise<WatchedIssueStatus | null>;

let issueStatusFetcher: IssueStatusFetcher = defaultIssueStatusFetcher;

async function defaultIssueStatusFetcher(
  ownerRepo: string,
  issueNumber: number
): Promise<WatchedIssueStatus | null> {
  try {
    const proc = Bun.spawn(
      [
        'gh', 'issue', 'view', String(issueNumber),
        '--repo', ownerRepo,
        '--json', 'number,state,comments',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) return null;

    const parsed = JSON.parse(output);
    return {
      number: parsed.number,
      state: parsed.state,
      comments: (parsed.comments ?? []).map((c: any) => ({
        author: { login: c.author?.login ?? 'unknown' },
        body: c.body ?? '',
        createdAt: c.createdAt ?? '',
      })),
    };
  } catch {
    return null;
  }
}

export function setIssueStatusFetcher(fetcher: IssueStatusFetcher): void {
  issueStatusFetcher = fetcher;
}

export function resetIssueStatusFetcher(): void {
  issueStatusFetcher = defaultIssueStatusFetcher;
}

// ─── Injectable blackboard accessor (for testing) ───────────────────────────

export type WatcherBlackboardAccessor = {
  listWorkItems(opts?: { all?: boolean; status?: string }): BlackboardWorkItem[];
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
  /** Mark a waiting_for_response item as completed (direct status update, no session needed) */
  completeWaitingItem(itemId: string): void;
  unblockWorkItem(itemId: string): unknown;
  updateWorkItemMetadata(itemId: string, updates: Record<string, unknown>): unknown;
};

let bbAccessor: WatcherBlackboardAccessor | null = null;

export function setWatcherBlackboardAccessor(accessor: WatcherBlackboardAccessor): void {
  bbAccessor = accessor;
}

export function resetWatcherBlackboardAccessor(): void {
  bbAccessor = null;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseWaitingMetadata(metadata: string | null): WaitingMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.waiting_type === 'github_issue' && parsed.watched_repo && parsed.watched_issue) {
      return parsed as WaitingMetadata;
    }
  } catch {
    // Invalid metadata JSON
  }
  return null;
}

function getNewComments(
  comments: WatchedIssueStatus['comments'],
  lastCheckedAt: string
): WatchedIssueStatus['comments'] {
  const lastChecked = new Date(lastCheckedAt).getTime();
  return comments.filter((c) => new Date(c.createdAt).getTime() > lastChecked);
}

// ─── Evaluator ──────────────────────────────────────────────────────────────

/**
 * Watch cross-project GitHub issues for activity and create continuations.
 *
 * For each waiting_for_response work item with waiting_type='github_issue':
 * - Fetches current issue state via gh CLI
 * - If issue closed: creates continuation work item, completes the watcher, unblocks originator
 * - If new comments: creates response work item for each new comment
 * - Updates last_checked_at in metadata
 */
export async function evaluateGithubIssueWatcher(item: ChecklistItem): Promise<CheckResult> {
  if (!bbAccessor) {
    return {
      item,
      status: 'error',
      summary: `Issue watcher check: ${item.name} — blackboard not configured`,
      details: { error: 'Blackboard accessor not set. Call setWatcherBlackboardAccessor() before evaluating.' },
    };
  }

  try {
    // Find all waiting_for_response work items
    const waitingItems = bbAccessor.listWorkItems({
      status: 'waiting_for_response',
    });

    // Filter to github_issue watchers
    const watchedItems = waitingItems
      .map((wi) => ({ item: wi, meta: parseWaitingMetadata(wi.metadata) }))
      .filter((x): x is { item: BlackboardWorkItem; meta: WaitingMetadata } => x.meta !== null);

    if (watchedItems.length === 0) {
      return {
        item,
        status: 'ok',
        summary: `Issue watcher check: ${item.name} — no issues being watched`,
        details: { watchedCount: 0, closedCount: 0, commentCount: 0 },
      };
    }

    let closedCount = 0;
    let commentCount = 0;
    const activityDetails: Array<{ repo: string; issue: number; activity: string }> = [];

    for (const { item: waitingItem, meta } of watchedItems) {
      const issueStatus = await issueStatusFetcher(meta.watched_repo, meta.watched_issue);

      if (!issueStatus) {
        // Could not fetch issue — skip this cycle, try again next time
        continue;
      }

      const now = new Date().toISOString();

      // Check for issue closure
      if (issueStatus.state === 'CLOSED' || issueStatus.state === 'closed') {
        // Create continuation work item
        const continuationId = `continuation-${meta.originating_item_id}-${Date.now()}`;
        const closedComments = issueStatus.comments.slice(-3); // Last 3 comments for context

        const descParts = [
          `## Cross-Project Dependency Resolved`,
          '',
          `The dependency issue has been closed:`,
          `- **Repository:** ${meta.watched_repo}`,
          `- **Issue:** #${meta.watched_issue}`,
          `- **Original work item:** ${meta.originating_item_id}`,
          '',
          `## Resume Context`,
          meta.resume_context,
        ];

        if (closedComments.length > 0) {
          descParts.push(
            '',
            '## Resolution Comments',
            ...closedComments.map((c) =>
              `**${c.author.login}** (${c.createdAt}):\n${c.body}`
            ),
          );
        }

        try {
          bbAccessor.createWorkItem({
            id: continuationId,
            title: `Resume: ${meta.originating_item_id} (dependency resolved)`,
            description: descParts.join('\n'),
            project: meta.originating_project || null,
            source: 'github',
            sourceRef: `https://github.com/${meta.watched_repo}/issues/${meta.watched_issue}`,
            priority: 'P1', // High priority: unblocked work should be resumed quickly
            metadata: JSON.stringify({
              continuation_of: meta.originating_item_id,
              resolved_issue: `${meta.watched_repo}#${meta.watched_issue}`,
              resolved_at: now,
              resolution_type: 'issue_closed',
            }),
          });
        } catch {
          // Work item may already exist — skip
        }

        // Unblock the original work item if it still exists
        try {
          bbAccessor.unblockWorkItem(meta.originating_item_id);
        } catch {
          // Original item may be in a different state or not found — non-fatal
        }

        // Complete the watcher item and update its metadata
        try {
          bbAccessor.updateWorkItemMetadata(waitingItem.item_id, {
            last_checked_at: now,
            resolved_at: now,
            resolution: 'issue_closed',
          });
          bbAccessor.completeWaitingItem(waitingItem.item_id);
        } catch {
          // Non-fatal — item may already be in a different state
        }

        closedCount++;
        activityDetails.push({
          repo: meta.watched_repo,
          issue: meta.watched_issue,
          activity: 'closed → continuation created',
        });
        continue;
      }

      // Check for new comments
      const newComments = getNewComments(issueStatus.comments, meta.last_checked_at);

      if (newComments.length > 0) {
        for (const comment of newComments) {
          const responseId = `response-${meta.watched_repo.replace('/', '-')}-${meta.watched_issue}-${Date.now()}`;

          const descParts = [
            `## New Comment on Watched Issue`,
            '',
            `- **Repository:** ${meta.watched_repo}`,
            `- **Issue:** #${meta.watched_issue}`,
            `- **Author:** ${comment.author.login}`,
            `- **Date:** ${comment.createdAt}`,
            `- **Original work item:** ${meta.originating_item_id}`,
            '',
            '## Comment',
            comment.body,
            '',
            '## Context',
            meta.resume_context,
          ];

          try {
            bbAccessor.createWorkItem({
              id: responseId,
              title: `Review comment on ${meta.watched_repo}#${meta.watched_issue} from ${comment.author.login}`,
              description: descParts.join('\n'),
              project: meta.originating_project || null,
              source: 'github',
              sourceRef: `https://github.com/${meta.watched_repo}/issues/${meta.watched_issue}`,
              priority: 'P2',
              metadata: JSON.stringify({
                comment_author: comment.author.login,
                comment_date: comment.createdAt,
                watched_repo: meta.watched_repo,
                watched_issue: meta.watched_issue,
                originating_item_id: meta.originating_item_id,
                response_type: 'issue_comment',
              }),
            });

            commentCount++;
            activityDetails.push({
              repo: meta.watched_repo,
              issue: meta.watched_issue,
              activity: `new comment from ${comment.author.login}`,
            });
          } catch {
            // Work item may already exist — skip
          }
        }
      }

      // Update last_checked_at regardless of activity
      try {
        bbAccessor.updateWorkItemMetadata(waitingItem.item_id, {
          last_checked_at: now,
        });
      } catch {
        // Non-fatal metadata update
      }
    }

    if (closedCount > 0 || commentCount > 0) {
      return {
        item,
        status: 'alert',
        summary: `Issue watcher check: ${item.name} — ${closedCount} resolved, ${commentCount} new comment(s) across ${watchedItems.length} watched issue(s)`,
        details: {
          watchedCount: watchedItems.length,
          closedCount,
          commentCount,
          activity: activityDetails,
        },
      };
    }

    return {
      item,
      status: 'ok',
      summary: `Issue watcher check: ${item.name} — no new activity on ${watchedItems.length} watched issue(s)`,
      details: {
        watchedCount: watchedItems.length,
        closedCount: 0,
        commentCount: 0,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `Issue watcher check: ${item.name} — error: ${msg}`,
      details: { error: msg },
    };
  }
}
