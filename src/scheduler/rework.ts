import { existsSync } from 'node:fs';
import type { Blackboard } from '../blackboard.ts';
import type { BlackboardProject, BlackboardWorkItem } from 'ivy-blackboard/src/types';
import type { SessionLauncher } from './types.ts';
import { formatInlineComments, type InlineComment } from './pr-comments.ts';
import {
  stashIfDirty,
  popStash,
  createWorktree,
  removeWorktree,
  resolveWorktreePath,
  ensureBranch,
  commitAll,
  pushBranch,
} from './worktree.ts';

/**
 * Maximum number of rework cycles allowed per PR to prevent infinite loops.
 * This is the hard safety limit. Projects can configure a lower limit
 * via project metadata `max_rework_cycles` (default: 2).
 */
export const MAX_REWORK_CYCLES = 3;

/**
 * Default configurable max rework cycles per project.
 * Projects can override via project metadata `max_rework_cycles`.
 */
export const DEFAULT_MAX_REWORK_CYCLES = 2;

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
  /** Path to the existing worktree for reuse (if available). */
  worktree_path?: string;
  /** Parsed file-level inline comments from the PR review. */
  inline_comments?: InlineComment[];
  /** Configurable max rework cycles for this project. */
  max_rework_cycles?: number;
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
        worktree_path: parsed.worktree_path,
        inline_comments: Array.isArray(parsed.inline_comments) ? parsed.inline_comments : undefined,
        max_rework_cycles: typeof parsed.max_rework_cycles === 'number' ? parsed.max_rework_cycles : undefined,
      };
    }
  } catch {
    // Invalid metadata JSON
  }
  return null;
}

/**
 * Resolve the effective max rework cycles for a project.
 * Priority: project metadata > metadata on work item > DEFAULT_MAX_REWORK_CYCLES.
 * Always capped at MAX_REWORK_CYCLES (hard safety limit).
 */
export function resolveMaxReworkCycles(
  bb: Blackboard,
  projectId: string,
  metaMaxCycles?: number,
): number {
  // Try project metadata first
  try {
    const project = bb.getProject(projectId);
    if (project?.metadata) {
      const projectMeta = JSON.parse(project.metadata);
      if (typeof projectMeta.max_rework_cycles === 'number') {
        return Math.min(projectMeta.max_rework_cycles, MAX_REWORK_CYCLES);
      }
    }
  } catch {
    // getProject not available or invalid metadata — fall through
  }

  // Use work item metadata, then default, then hard limit
  if (typeof metaMaxCycles === 'number') {
    return Math.min(metaMaxCycles, MAX_REWORK_CYCLES);
  }

  // No project config and no metadata override — use default
  return DEFAULT_MAX_REWORK_CYCLES;
}

/**
 * Create a rework work item on the blackboard.
 *
 * Returns the created work item ID, or null if the cycle limit is exceeded.
 * Includes idempotency check — returns existing item ID if one exists for
 * the same PR and cycle.
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
    worktreePath?: string;
    inlineComments?: InlineComment[];
    maxReworkCycles?: number;
  }
): string | null {
  // Resolve effective max cycles
  const effectiveMax = resolveMaxReworkCycles(bb, opts.projectId, opts.maxReworkCycles);

  // Guard against infinite loops — use both the configurable and hard limit
  if (opts.reworkCycle > MAX_REWORK_CYCLES) {
    bb.appendEvent({
      actorId: opts.sessionId,
      targetId: opts.implementationWorkItemId,
      summary: `Rework cycle limit reached (${opts.reworkCycle}/${MAX_REWORK_CYCLES}) for PR #${opts.prNumber} — requires manual review`,
      metadata: { prNumber: opts.prNumber, reworkCycle: opts.reworkCycle, maxCycles: MAX_REWORK_CYCLES },
    });
    return null;
  }

  // Check configurable max (may be lower than hard limit)
  if (opts.reworkCycle > effectiveMax) {
    // Escalation: mark the original work item with human_review_required
    try {
      bb.updateWorkItemMetadata(opts.implementationWorkItemId, {
        human_review_required: true,
        escalation_reason: `Max rework cycles (${effectiveMax}) exceeded`,
        escalated_at: new Date().toISOString(),
      });
    } catch {
      // Best effort — original item may not exist
    }

    bb.appendEvent({
      actorId: opts.sessionId,
      targetId: opts.implementationWorkItemId,
      summary: `PR #${opts.prNumber} exceeded max rework cycles (${effectiveMax}) — escalating to human review`,
      metadata: { prNumber: opts.prNumber, reworkCycle: opts.reworkCycle, maxCycles: effectiveMax, eventType: 'human_escalation' },
    });
    return null;
  }

  const itemId = `rework-${opts.projectId}-pr-${opts.prNumber}-cycle-${opts.reworkCycle}`;

  // Idempotency check: don't create duplicate rework items for same PR/cycle
  try {
    const pending = bb.listWorkItems({ status: 'pending' });
    const claimed = bb.listWorkItems({ status: 'claimed' });
    const existing = [...pending, ...claimed].find((i) => {
      const meta = parseReworkMeta(i.metadata);
      return meta?.pr_number === opts.prNumber && meta?.rework_cycle === opts.reworkCycle;
    });
    if (existing) {
      return existing.item_id;
    }
  } catch {
    // listWorkItems may fail — proceed with creation attempt
  }

  const description = [
    `Rework requested for PR #${opts.prNumber} (cycle ${opts.reworkCycle}/${effectiveMax}).`,
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
    worktree_path: opts.worktreePath,
    inline_comments: opts.inlineComments,
    max_rework_cycles: effectiveMax,
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
 * 1. Reuse existing worktree or create one for the PR branch
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
  let wtPath: string;
  let reusingWorktree = false;

  try {
    // Reuse existing worktree if path is provided and valid
    if (meta.worktree_path && existsSync(meta.worktree_path)) {
      wtPath = meta.worktree_path;
      await ensureBranch(wtPath, meta.branch);
      reusingWorktree = true;
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Rework: reusing existing worktree at ${wtPath}`,
      });
    } else {
      // Fallback: create new worktree
      didStash = await stashIfDirty(project.local_path);
      wtPath = await createWorktree(project.local_path, meta.branch, meta.project_id);
      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Rework: created worktree for branch ${meta.branch} at ${wtPath}`,
      });
    }

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

    // Commit and push any remaining rework changes (agent may have already committed/pushed)
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
    }

    // Always create re-review work item — agent may have committed/pushed directly
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
          worktree_path: wtPath,
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

    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Rework completed for PR #${meta.pr_number} (cycle ${meta.rework_cycle})`,
    });
  } finally {
    // Only clean up worktree if we created it (not if reusing)
    if (!reusingWorktree) {
      try { await removeWorktree(project.local_path, rwWorktreePath); } catch { /* best effort */ }
    }
    if (didStash) {
      await popStash(project.local_path);
    }
  }
}

/**
 * Build the prompt for a rework agent that addresses review feedback.
 */
export function buildReworkPrompt(meta: ReworkMetadata): string {
  const effectiveMax = meta.max_rework_cycles ?? MAX_REWORK_CYCLES;
  const parts = [
    `You are addressing code review feedback for PR #${meta.pr_number} in ${meta.repo}.`,
    `This is rework cycle ${meta.rework_cycle}/${effectiveMax}.`,
    '',
    '## Review Feedback to Address',
    '',
    meta.review_feedback,
    '',
  ];

  // Include structured inline comments if available
  if (meta.inline_comments && meta.inline_comments.length > 0) {
    parts.push(...formatInlineComments(meta.inline_comments));
  }

  parts.push(
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
  );

  return parts.join('\n');
}
