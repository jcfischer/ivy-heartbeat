import type { Blackboard } from '../blackboard.ts';
import type { BlackboardProject, BlackboardWorkItem } from 'ivy-blackboard/src/types';
import { mergePR, pullMain, getPRState } from './worktree.ts';
import { createMergeFixWorkItem } from './merge-fix.ts';
import type { ReflectMetadata } from '../reflect/types.ts';

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

  let shouldCreateReflect = false;

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

    shouldCreateReflect = true;
  }

  // Check if the PR was actually merged despite the gh merge command failing
  const prState = await getPRState(project.local_path, meta.pr_number);
  if (prState === 'MERGED') {
    try {
      await pullMain(project.local_path, meta.main_branch);
    } catch { /* non-fatal */ }
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `PR #${meta.pr_number} already merged — skipping merge-fix`,
      metadata: { prNumber: meta.pr_number, prState: 'MERGED' },
    });

    shouldCreateReflect = true;
  }

  // Create reflect work item for lesson extraction if PR was merged
  if (shouldCreateReflect) {
    createReflectWorkItem(bb, {
      projectId: meta.project_id,
      implementationWorkItemId: meta.implementation_work_item_id,
      prNumber: meta.pr_number,
      prUrl: meta.pr_url,
      originalTitle: item.title.replace(/^Merge approved PR #\d+ - /, ''),
      sessionId,
    });

    return;
  }

  // Merge genuinely failed — create merge-fix recovery item
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

/**
 * Create a reflect work item after successful PR merge.
 * Called when a PR merge completes successfully to trigger lesson extraction.
 *
 * Returns the created work item ID.
 */
export function createReflectWorkItem(
  bb: Blackboard,
  opts: {
    projectId: string;
    implementationWorkItemId: string;
    prNumber: number;
    prUrl: string;
    originalTitle: string;
    sessionId?: string;
  }
): string {
  const itemId = `reflect-${opts.projectId}-pr-${opts.prNumber}`;
  const title = `Reflect on PR #${opts.prNumber} - ${opts.originalTitle}`;

  const description = [
    `Extract lessons from completed implementation cycle.`,
    '',
    `- **PR URL:** ${opts.prUrl}`,
    `- **Implementation Work Item:** ${opts.implementationWorkItemId}`,
    `- **Project:** ${opts.projectId}`,
  ].join('\n');

  const metadata: ReflectMetadata = {
    reflect: true,
    project_id: opts.projectId,
    implementation_work_item_id: opts.implementationWorkItemId,
    pr_number: opts.prNumber,
    pr_url: opts.prUrl,
  };

  bb.createWorkItem({
    id: itemId,
    title,
    description,
    project: opts.projectId,
    priority: 'P2',
    source: 'reflect',
    sourceRef: opts.prUrl,
    metadata: JSON.stringify(metadata),
  });

  bb.appendEvent({
    actorId: opts.sessionId,
    targetId: opts.implementationWorkItemId,
    summary: `Created reflect work item "${itemId}" for lesson extraction`,
    metadata: { reflectItemId: itemId, prNumber: opts.prNumber },
  });

  return itemId;
}
