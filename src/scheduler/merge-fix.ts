import type { Blackboard } from '../blackboard.ts';
import type { BlackboardProject, BlackboardWorkItem } from 'ivy-blackboard/src/types';
import type { SessionLauncher } from './types.ts';
import {
  ensureWorktree,
  resolveWorktreePath,
  rebaseOnMain,
  forcePushBranch,
  commitAll,
  pushBranch,
  mergePR,
  pullMain,
} from './worktree.ts';

/**
 * Metadata shape for merge-fix recovery work items.
 */
export interface MergeFixMetadata {
  merge_fix: true;
  pr_number: number;
  pr_url: string;
  branch: string;
  main_branch: string;
  original_item_id: string;
  original_issue_number?: number;
  project_id: string;
}

/**
 * Parse work item metadata to extract merge-fix fields.
 * Returns null if the metadata does not represent a merge-fix item.
 */
export function parseMergeFixMeta(metadata: string | null): MergeFixMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    if (parsed.merge_fix === true && parsed.pr_number && parsed.branch && parsed.main_branch) {
      return {
        merge_fix: true,
        pr_number: parsed.pr_number,
        pr_url: parsed.pr_url,
        branch: parsed.branch,
        main_branch: parsed.main_branch,
        original_item_id: parsed.original_item_id,
        original_issue_number: parsed.original_issue_number,
        project_id: parsed.project_id,
      };
    }
  } catch {
    // Invalid metadata JSON
  }
  return null;
}

/**
 * Create a merge-fix recovery work item on the blackboard.
 * Called when auto-merge fails on a trusted path.
 *
 * Returns the created work item ID.
 */
export function createMergeFixWorkItem(
  bb: Blackboard,
  opts: {
    originalItemId: string;
    prNumber: number;
    prUrl: string;
    branch: string;
    mainBranch: string;
    issueNumber?: number;
    projectId: string;
    originalTitle: string;
    sessionId?: string;
  }
): string {
  const itemId = `merge-fix-${opts.originalItemId}-${opts.prNumber}`;
  const title = opts.issueNumber
    ? `Fix merge conflict: PR #${opts.prNumber} for #${opts.issueNumber}`
    : `Fix merge conflict: PR #${opts.prNumber}`;

  const description = [
    `Auto-merge failed for PR #${opts.prNumber}.`,
    '',
    `- **PR URL:** ${opts.prUrl}`,
    `- **Branch:** ${opts.branch}`,
    `- **Base:** ${opts.mainBranch}`,
    `- **Original task:** ${opts.originalTitle}`,
    '',
    'This work item will attempt to rebase the branch on main and re-merge.',
    'If rebase has conflicts, a Claude agent will resolve them.',
  ].join('\n');

  const metadata: MergeFixMetadata = {
    merge_fix: true,
    pr_number: opts.prNumber,
    pr_url: opts.prUrl,
    branch: opts.branch,
    main_branch: opts.mainBranch,
    original_item_id: opts.originalItemId,
    original_issue_number: opts.issueNumber,
    project_id: opts.projectId,
  };

  bb.createWorkItem({
    id: itemId,
    title,
    description,
    project: opts.projectId,
    priority: 'P1',
    source: 'merge-fix',
    metadata: JSON.stringify(metadata),
  });

  bb.appendEvent({
    actorId: opts.sessionId,
    targetId: opts.originalItemId,
    summary: `Created merge-fix work item "${itemId}" for PR #${opts.prNumber}`,
    metadata: { mergeFixItemId: itemId, prNumber: opts.prNumber },
  });

  return itemId;
}

/**
 * Execute the merge-fix recovery flow:
 * 1. Ensure worktree exists for the PR branch
 * 2. Attempt rebase on main
 * 3. If clean: force-push and re-merge
 * 4. If conflicts: launch Claude agent to resolve, then commit + push + merge
 * 5. On success: pull main to sync
 */
export async function runMergeFix(
  bb: Blackboard,
  item: BlackboardWorkItem,
  meta: MergeFixMetadata,
  project: BlackboardProject,
  sessionId: string,
  launcher: SessionLauncher,
  timeoutMs: number
): Promise<void> {
  const expectedPath = resolveWorktreePath(project.local_path, meta.branch, meta.project_id);
  const worktreePath = await ensureWorktree(project.local_path, expectedPath, meta.branch);

  bb.appendEvent({
    actorId: sessionId,
    targetId: item.item_id,
    summary: `Merge-fix: ensured worktree for branch ${meta.branch} at ${worktreePath}`,
  });

  // Step 1: Try rebase on main
  const rebased = await rebaseOnMain(worktreePath, meta.main_branch);

  if (rebased) {
    // Clean rebase — force-push and re-merge
    await forcePushBranch(worktreePath, meta.branch);
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Merge-fix: rebased ${meta.branch} on ${meta.main_branch} and force-pushed`,
    });

    const merged = await mergePR(worktreePath, meta.pr_number);
    if (merged) {
      try {
        await pullMain(project.local_path, meta.main_branch);
      } catch { /* non-fatal */ }

      bb.appendEvent({
        actorId: sessionId,
        targetId: item.item_id,
        summary: `Merge-fix: successfully merged PR #${meta.pr_number} after rebase`,
        metadata: { prNumber: meta.pr_number, method: 'rebase' },
      });
      return;
    }
    // Merge still failed after rebase — fall through to agent
  }

  // Step 2: Rebase failed or merge still failing — launch agent to resolve conflicts
  bb.appendEvent({
    actorId: sessionId,
    targetId: item.item_id,
    summary: `Merge-fix: rebase had conflicts, launching agent to resolve`,
  });

  // Start a merge so the agent can see conflict markers
  try {
    await mergeMainIntoWorktree(worktreePath, meta.main_branch);
  } catch {
    // Expected — merge will fail with conflicts, leaving markers in files
  }

  const prompt = buildMergeFixPrompt(meta);
  const result = await launcher({
    workDir: worktreePath,
    prompt,
    timeoutMs,
    sessionId: `${sessionId}-merge-fix`,
    disableMcp: true,
  });

  if (result.exitCode !== 0) {
    throw new Error(`Agent failed to resolve merge conflicts (exit ${result.exitCode})`);
  }

  // Agent resolved conflicts — commit, push, merge
  const sha = await commitAll(worktreePath, `Resolve merge conflicts for PR #${meta.pr_number}`);
  if (sha) {
    await pushBranch(worktreePath, meta.branch);
  }

  const merged = await mergePR(worktreePath, meta.pr_number);
  if (!merged) {
    throw new Error(`PR #${meta.pr_number} still cannot be merged after conflict resolution`);
  }

  try {
    await pullMain(project.local_path, meta.main_branch);
  } catch { /* non-fatal */ }

  bb.appendEvent({
    actorId: sessionId,
    targetId: item.item_id,
    summary: `Merge-fix: successfully merged PR #${meta.pr_number} after agent conflict resolution`,
    metadata: { prNumber: meta.pr_number, method: 'agent-resolve', commitSha: sha },
  });
}

/**
 * Start a merge of main into the worktree branch (will leave conflict markers).
 */
async function mergeMainIntoWorktree(
  worktreePath: string,
  mainBranch: string
): Promise<void> {
  const run = async (args: string[]) => {
    const proc = Bun.spawn(['git', ...args], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
    }
    return stdout.trim();
  };

  try {
    await run(['fetch', 'origin']);
  } catch { /* may fail if no remote */ }

  // This will fail with conflicts — that's expected
  await run(['merge', `origin/${mainBranch}`, '--no-commit']);
}

/**
 * Build the prompt for a Claude agent resolving merge conflicts.
 */
function buildMergeFixPrompt(meta: MergeFixMetadata): string {
  return [
    `You are resolving merge conflicts in branch "${meta.branch}".`,
    '',
    `PR #${meta.pr_number}: ${meta.pr_url}`,
    `The branch needs to be merged into ${meta.main_branch} but has conflicts.`,
    '',
    'The working directory has conflict markers in files. Your job:',
    '1. Find all files with conflict markers (<<<<<<< / ======= / >>>>>>>)',
    '2. Resolve each conflict by keeping the correct code',
    '3. Stage all resolved files with `git add`',
    '',
    'Do NOT commit, push, or create PRs. Just resolve the conflicts and stage the files.',
    'When done, summarize which files you resolved and how.',
  ].join('\n');
}
