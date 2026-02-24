import type { Blackboard } from '../blackboard.ts';
import type { BlackboardProject, BlackboardWorkItem } from 'ivy-blackboard/src/types';
import type { SessionLauncher } from './types.ts';
import {
  stashIfDirty,
  popStash,
  createWorktree,
  removeWorktree,
  resolveWorktreePath,
  commitAll,
  pushBranch,
  getPRState,
  reopenPR,
  remoteBranchExists,
  createPR,
} from './worktree.ts';

/**
 * Maximum number of rework cycles allowed per PR to prevent infinite loops.
 */
export const MAX_REWORK_CYCLES = 3;

/**
 * Metadata shape for rework work items.
 */
export interface ReworkMetadata {
  rework: true;
  pr_number: number;
  pr_url: string;
  repo: string;
  branch: string;
  main_branch: string;
  implementation_work_item_id: string;
  review_feedback: string;
  rework_cycle: number;
  project_id: string;
}

/**
 * Parse work item metadata to extract rework fields.
 * Returns null if the metadata does not represent a rework item.
 */
export function parseReworkMeta(metadata: string | null): ReworkMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.rework === true && parsed.pr_number && parsed.branch && parsed.repo) {
      return {
        rework: true,
        pr_number: parsed.pr_number,
        pr_url: parsed.pr_url ?? '',
        repo: parsed.repo,
        branch: parsed.branch,
        main_branch: parsed.main_branch ?? 'main',
        implementation_work_item_id: parsed.implementation_work_item_id ?? '',
        review_feedback: parsed.review_feedback ?? '',
        rework_cycle: typeof parsed.rework_cycle === 'number' ? parsed.rework_cycle : 1,
        project_id: parsed.project_id ?? '',
      };
    }
  } catch {
    // Invalid metadata JSON
  }
  return null;
}

/**
 * Create a rework work item on the blackboard.
 *
 * Returns the created work item ID, or null if the cycle limit is exceeded.
 */
export function createReworkWorkItem(
  bb: Blackboard,
  opts: {
    prNumber: number;
    prUrl: string;
    repo: string;
    branch: string;
    mainBranch?: string;
    implementationWorkItemId: string;
    reviewFeedback: string;
    reworkCycle: number;
    projectId: string;
    originalTitle: string;
    sessionId?: string;
  }
): string | null {
  // Guard against infinite loops
  if (opts.reworkCycle > MAX_REWORK_CYCLES) {
    bb.appendEvent({
      actorId: opts.sessionId,
      targetId: opts.implementationWorkItemId,
      summary: `Rework cycle limit reached (${opts.reworkCycle}/${MAX_REWORK_CYCLES}) for PR #${opts.prNumber} — requires manual review`,
      metadata: { prNumber: opts.prNumber, reworkCycle: opts.reworkCycle, maxCycles: MAX_REWORK_CYCLES },
    });
    return null;
  }

  const itemId = `rework-${opts.projectId}-pr-${opts.prNumber}-cycle-${opts.reworkCycle}`;

  const description = [
    `Rework requested for PR #${opts.prNumber} (cycle ${opts.reworkCycle}/${MAX_REWORK_CYCLES}).`,
    '',
    `- **PR URL:** ${opts.prUrl}`,
    `- **Repo:** ${opts.repo}`,
    `- **Branch:** ${opts.branch}`,
    `- **Original task:** ${opts.originalTitle}`,
    '',
    '## Review Feedback',
    '',
    opts.reviewFeedback,
  ].join('\n');

  const metadata: ReworkMetadata = {
    rework: true,
    pr_number: opts.prNumber,
    pr_url: opts.prUrl,
    repo: opts.repo,
    branch: opts.branch,
    main_branch: opts.mainBranch ?? 'main',
    implementation_work_item_id: opts.implementationWorkItemId,
    review_feedback: opts.reviewFeedback,
    rework_cycle: opts.reworkCycle,
    project_id: opts.projectId,
  };

  bb.createWorkItem({
    id: itemId,
    title: `Rework: PR #${opts.prNumber} - ${opts.originalTitle} (cycle ${opts.reworkCycle})`,
    description,
    project: opts.projectId,
    priority: 'P1',
    source: 'rework',
    sourceRef: opts.prUrl,
    metadata: JSON.stringify(metadata),
  });

  bb.appendEvent({
    actorId: opts.sessionId,
    targetId: opts.implementationWorkItemId,
    summary: `Created rework work item "${itemId}" for PR #${opts.prNumber} (cycle ${opts.reworkCycle})`,
    metadata: { reworkItemId: itemId, prNumber: opts.prNumber, reworkCycle: opts.reworkCycle },
  });

  return itemId;
}

/**
 * Execute the rework flow:
 * 1. Create worktree for the PR branch
 * 2. Run rework agent with review feedback
 * 3. Commit and push changes
 * 4. Create re-review work item
 *
 * Throws on failure. Caller handles completion/release and worktree cleanup.
 */
export async function runRework(
  bb: Blackboard,
  item: BlackboardWorkItem,
  meta: ReworkMetadata,
  project: BlackboardProject,
  sessionId: string,
  launcher: SessionLauncher,
  timeoutMs: number,
): Promise<void> {
  const rwWorktreePath = resolveWorktreePath(project.local_path, meta.branch, meta.project_id);
  let didStash = false;

  // Check PR state before starting work — recover if PR was closed prematurely
  const prState = await getPRState(project.local_path, meta.pr_number);

  if (prState === 'CLOSED') {
    const branchExists = await remoteBranchExists(project.local_path, meta.branch);

    if (branchExists) {
      // Branch still exists — try to reopen the PR
      const reopened = await reopenPR(project.local_path, meta.pr_number);
      if (reopened) {
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Reopened closed PR #${meta.pr_number} to allow rework (branch ${meta.branch} still exists)`,
          metadata: { prNumber: meta.pr_number, recovery: 'reopen' },
        });
      } else {
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `PR #${meta.pr_number} is closed and could not be reopened — rework blocked`,
          metadata: { prNumber: meta.pr_number, recovery: 'reopen_failed' },
        });
        throw new Error(`PR #${meta.pr_number} is closed and could not be reopened`);
      }
    } else {
      // Branch deleted — check if worktree exists to recreate
      const { existsSync } = await import('node:fs');
      if (existsSync(rwWorktreePath)) {
        // Push branch from worktree and create a new PR
        try {
          await pushBranch(rwWorktreePath, meta.branch);
          const newPr = await createPR(
            rwWorktreePath,
            `Rework: ${item.title}`,
            `Recreated from worktree after PR #${meta.pr_number} was closed prematurely.\n\nOriginal review feedback:\n${meta.review_feedback}`,
            meta.main_branch
          );
          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `PR #${meta.pr_number} was closed and branch deleted — recreated as PR #${newPr.number} from worktree`,
            metadata: { oldPrNumber: meta.pr_number, newPrNumber: newPr.number, newPrUrl: newPr.url, recovery: 'recreate' },
          });
          // Update metadata with new PR info
          meta.pr_number = newPr.number;
          meta.pr_url = newPr.url;
        } catch (recreateErr: unknown) {
          const msg = recreateErr instanceof Error ? recreateErr.message : String(recreateErr);
          bb.appendEvent({
            actorId: sessionId,
            targetId: item.item_id,
            summary: `PR #${meta.pr_number} closed, branch deleted, worktree exists but PR recreation failed: ${msg}`,
            metadata: { prNumber: meta.pr_number, recovery: 'recreate_failed', error: msg },
          });
          throw new Error(`PR #${meta.pr_number} closed, branch deleted, recreation failed: ${msg}`);
        }
      } else {
        // No branch, no worktree — unrecoverable
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `PR #${meta.pr_number} closed, branch ${meta.branch} deleted, no worktree found — rework blocked, requires manual intervention`,
          metadata: { prNumber: meta.pr_number, branch: meta.branch, recovery: 'unrecoverable' },
        });
        throw new Error(`PR #${meta.pr_number} closed, branch ${meta.branch} deleted, no worktree — unrecoverable`);
      }
    }
  } else if (prState === 'MERGED') {
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `PR #${meta.pr_number} already merged — rework no longer needed`,
      metadata: { prNumber: meta.pr_number, prState: 'MERGED' },
    });
    return; // Nothing to do — PR was already merged
  }

  try {
    didStash = await stashIfDirty(project.local_path);
    const wtPath = await createWorktree(project.local_path, meta.branch, meta.project_id);

    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Rework: created worktree for branch ${meta.branch} at ${wtPath}`,
    });

    const prompt = buildReworkPrompt(meta);
    const result = await launcher({
      workDir: wtPath,
      prompt,
      timeoutMs,
      sessionId,
      disableMcp: true,
    });

    if (result.exitCode !== 0) {
      throw new Error(`Rework agent failed (exit ${result.exitCode})`);
    }

    // Commit and push the rework changes
    const sha = await commitAll(
      wtPath,
      `Address review feedback for PR #${meta.pr_number} (cycle ${meta.rework_cycle})`
    );

    if (sha) {
      await pushBranch(wtPath, meta.branch);
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Rework: pushed fixes for PR #${meta.pr_number} (cycle ${meta.rework_cycle})`,
        metadata: { commitSha: sha, prNumber: meta.pr_number },
      });

      // Create a new review work item to trigger re-review
      const reviewItemId = `review-${meta.project_id}-pr-${meta.pr_number}-cycle-${meta.rework_cycle}`;
      try {
        bb.createWorkItem({
          id: reviewItemId,
          title: `Code review: PR #${meta.pr_number} (post-rework cycle ${meta.rework_cycle})`,
          description: `AI code review for PR #${meta.pr_number} after rework cycle ${meta.rework_cycle}\nBranch: ${meta.branch}\nRepo: ${meta.repo}`,
          project: meta.project_id,
          source: 'code_review',
          sourceRef: meta.pr_url,
          priority: 'P1',
          metadata: JSON.stringify({
            pr_number: meta.pr_number,
            pr_url: meta.pr_url,
            repo: meta.repo,
            branch: meta.branch,
            main_branch: meta.main_branch,
            implementation_work_item_id: meta.implementation_work_item_id,
            rework_cycle: meta.rework_cycle,
            review_status: null,
          }),
        });
        bb.appendEvent({
          actorId: sessionId,
          targetId: item.item_id,
          summary: `Created re-review work item ${reviewItemId} for PR #${meta.pr_number}`,
          metadata: { reviewItemId, reworkCycle: meta.rework_cycle },
        });
      } catch {
        // Review item may already exist — non-fatal
      }
    }

    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Rework completed for PR #${meta.pr_number} (cycle ${meta.rework_cycle})`,
    });
  } finally {
    try { await removeWorktree(project.local_path, rwWorktreePath); } catch { /* best effort */ }
    if (didStash) {
      await popStash(project.local_path);
    }
  }
}

/**
 * Build the prompt for a rework agent that addresses review feedback.
 */
export function buildReworkPrompt(meta: ReworkMetadata): string {
  return [
    `You are addressing code review feedback for PR #${meta.pr_number} in ${meta.repo}.`,
    `This is rework cycle ${meta.rework_cycle}/${MAX_REWORK_CYCLES}.`,
    '',
    '## Review Feedback to Address',
    '',
    meta.review_feedback,
    '',
    '## Instructions',
    '',
    `1. Read the review comments on PR #${meta.pr_number}:`,
    `   gh pr view ${meta.pr_number} --repo ${meta.repo} --json reviews,comments`,
    `   gh api repos/${meta.repo}/pulls/${meta.pr_number}/comments`,
    '',
    '2. For each issue raised:',
    '   - Understand what the reviewer is requesting',
    '   - Make the necessary code changes',
    '   - Ensure the fix is correct and complete',
    '',
    '3. After addressing all feedback:',
    '   - Run any relevant tests to verify your changes',
    '   - Summarize what you changed and why',
    '',
    'IMPORTANT: Only fix the issues raised in the review. Do not refactor unrelated code.',
    'When done, summarize what you changed for each review comment.',
  ].join('\n');
}
