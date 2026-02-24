import type { Blackboard } from '../blackboard.ts';
import type { BlackboardProject, BlackboardWorkItem } from 'ivy-blackboard/src/types';
import { mergePR, pullMain } from './worktree.ts';
import { createMergeFixWorkItem } from './merge-fix.ts';

/**
 * Metadata shape for post-review PR merge work items.
 * Created when a code review approves a PR — triggering merge in the next dispatch cycle.
 */
export interface PRMergeMetadata {
  pr_merge: true;
  pr_number: number;
  pr_url: string;
  repo: string;
  branch: string;
  main_branch: string;
  implementation_work_item_id: string;
  project_id: string;
}

/**
 * Parse work item metadata to extract PR merge fields.
 * Returns null if the metadata does not represent a merge item.
 */
export function parsePRMergeMeta(metadata: string | null): PRMergeMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.pr_merge === true && parsed.pr_number && parsed.repo && parsed.branch) {
      return {
        pr_merge: true,
        pr_number: parsed.pr_number,
        pr_url: parsed.pr_url ?? '',
        repo: parsed.repo,
        branch: parsed.branch,
        main_branch: parsed.main_branch ?? 'main',
        implementation_work_item_id: parsed.implementation_work_item_id ?? '',
        project_id: parsed.project_id ?? '',
      };
    }
  } catch {
    // Invalid metadata JSON
  }
  return null;
}

/**
 * Create a post-review PR merge work item on the blackboard.
 * Called when a code review approves a PR.
 *
 * Returns the created work item ID.
 */
export function createPRMergeWorkItem(
  bb: Blackboard,
  opts: {
    prNumber: number;
    prUrl: string;
    repo: string;
    branch: string;
    mainBranch: string;
    implementationWorkItemId: string;
    projectId: string;
    originalTitle: string;
    sessionId?: string;
  }
): string {
  const itemId = `merge-${opts.projectId}-pr-${opts.prNumber}`;
  const title = `Merge approved PR #${opts.prNumber} - ${opts.originalTitle}`;

  const description = [
    `Code review approved PR #${opts.prNumber}. Ready to merge.`,
    '',
    `- **PR URL:** ${opts.prUrl}`,
    `- **Repo:** ${opts.repo}`,
    `- **Branch:** ${opts.branch}`,
    `- **Base:** ${opts.mainBranch}`,
  ].join('\n');

  const metadata: PRMergeMetadata = {
    pr_merge: true,
    pr_number: opts.prNumber,
    pr_url: opts.prUrl,
    repo: opts.repo,
    branch: opts.branch,
    main_branch: opts.mainBranch,
    implementation_work_item_id: opts.implementationWorkItemId,
    project_id: opts.projectId,
  };

  bb.createWorkItem({
    id: itemId,
    title,
    description,
    project: opts.projectId,
    priority: 'P1',
    source: 'pr_merge',
    sourceRef: opts.prUrl,
    metadata: JSON.stringify(metadata),
  });

  bb.appendEvent({
    actorId: opts.sessionId,
    targetId: opts.implementationWorkItemId,
    summary: `Created merge work item "${itemId}" for approved PR #${opts.prNumber}`,
    metadata: { mergeItemId: itemId, prNumber: opts.prNumber },
  });

  return itemId;
}

/**
 * Execute the PR merge flow:
 * 1. Merge the approved PR via gh CLI
 * 2. Pull merged changes into main repo
 * 3. If merge fails → create merge-fix recovery item
 */
export async function runPRMerge(
  bb: Blackboard,
  item: BlackboardWorkItem,
  meta: PRMergeMetadata,
  project: BlackboardProject,
  sessionId: string,
): Promise<void> {
  const merged = await mergePR(project.local_path, meta.pr_number);

  if (merged) {
    // Pull merged changes into local main
    try {
      await pullMain(project.local_path, meta.main_branch);
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Pulled merged changes from PR #${meta.pr_number} into ${meta.main_branch}`,
        metadata: { mainBranch: meta.main_branch },
      });
    } catch (pullErr: unknown) {
      const pullMsg = pullErr instanceof Error ? pullErr.message : String(pullErr);
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Pull after merge failed (non-fatal): ${pullMsg}`,
        metadata: { error: pullMsg },
      });
    }

    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Merged PR #${meta.pr_number} (squash + delete branch)`,
      metadata: { prNumber: meta.pr_number, merged: true },
    });
    return;
  }

  // Merge failed — create merge-fix recovery item
  const mergeFixId = createMergeFixWorkItem(bb, {
    originalItemId: meta.implementation_work_item_id,
    prNumber: meta.pr_number,
    prUrl: meta.pr_url,
    branch: meta.branch,
    mainBranch: meta.main_branch,
    projectId: meta.project_id,
    originalTitle: item.title.replace(/^Merge approved PR #\d+ - /, ''),
    sessionId,
  });

  bb.appendEvent({
    actorId: sessionId,
    targetId: item.item_id,
    summary: `PR #${meta.pr_number} merge failed — created merge-fix recovery item ${mergeFixId}`,
    metadata: { prNumber: meta.pr_number, mergeFixItemId: mergeFixId },
  });
}
