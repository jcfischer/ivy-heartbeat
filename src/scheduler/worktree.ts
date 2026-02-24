import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface WorktreeContext {
  projectPath: string;    // main repo
  worktreePath: string;   // isolated checkout
  branch: string;
}

export interface PostAgentResult {
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
}

// ─── Review cycle guard ──────────────────────────────────────────────────

/**
 * Accessor interface for checking active review cycles on the blackboard.
 * Injectable for testability (same pattern as specflow-cleanup.ts).
 */
export type ReviewCycleAccessor = {
  listWorkItems(opts?: { status?: string }): Array<{
    item_id: string;
    source: string | null;
    metadata: string | null;
    status: string;
  }>;
};

let reviewCycleAccessor: ReviewCycleAccessor | null = null;

export function setReviewCycleAccessor(accessor: ReviewCycleAccessor): void {
  reviewCycleAccessor = accessor;
}

export function resetReviewCycleAccessor(): void {
  reviewCycleAccessor = null;
}

/**
 * Check if a branch has an active review/rework cycle.
 * Returns true if any pending or claimed work items exist that reference
 * this branch in their metadata (review, rework, pr_merge, merge-fix).
 *
 * When true, the branch must NOT be deleted — a PR depends on it.
 */
export function hasActiveReviewCycle(branch: string): boolean {
  if (!reviewCycleAccessor) return false;

  const REVIEW_SOURCES = new Set(['code_review', 'rework', 'pr_merge', 'merge-fix']);

  for (const status of ['pending', 'claimed'] as const) {
    let items: Array<{ source: string | null; metadata: string | null }>;
    try {
      items = reviewCycleAccessor.listWorkItems({ status });
    } catch {
      continue;
    }
    for (const item of items) {
      // Quick source check first
      if (item.source && REVIEW_SOURCES.has(item.source)) {
        if (metadataReferencesBranch(item.metadata, branch)) return true;
      }
      // Also check metadata flags regardless of source (for items with generic source)
      if (item.metadata) {
        try {
          const meta = JSON.parse(item.metadata);
          if ((meta.rework || meta.pr_merge || meta.merge_fix || meta.review_status !== undefined)
            && metadataReferencesBranch(item.metadata, branch)) {
            return true;
          }
        } catch {
          // Invalid JSON — skip
        }
      }
    }
  }

  return false;
}

/**
 * Check if a work item's metadata references a given branch name.
 */
function metadataReferencesBranch(metadata: string | null, branch: string): boolean {
  if (!metadata) return false;
  try {
    const meta = JSON.parse(metadata);
    return meta.branch === branch;
  } catch {
    return false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Run a git command and return trimmed stdout.
 * Throws on non-zero exit code.
 */
async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
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
}

/**
 * Run a gh CLI command and return trimmed stdout.
 * Throws on non-zero exit code.
 */
async function gh(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(['gh', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`gh ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
  }

  return stdout.trim();
}

// ─── Worktree base directory ──────────────────────────────────────────────

function worktreeBaseDir(): string {
  if (process.env.IVY_WORKTREE_DIR) return process.env.IVY_WORKTREE_DIR;
  const home = process.env.HOME ?? '/tmp';
  return join(home, '.pai', 'worktrees');
}

/**
 * Resolve the expected worktree path for a given project + branch combination.
 * Matches the path derivation used by createWorktree().
 */
export function resolveWorktreePath(projectPath: string, branch: string, projectId?: string): string {
  const dirName = projectId ?? projectPath.split('/').pop() ?? 'unknown';
  return join(worktreeBaseDir(), dirName, branch);
}

// ─── Pre-flight ───────────────────────────────────────────────────────────

/**
 * Check if the working tree is clean (no uncommitted changes).
 */
export async function isCleanBranch(projectPath: string): Promise<boolean> {
  const status = await git(['status', '--porcelain'], projectPath);
  return status.length === 0;
}

/**
 * Stash uncommitted changes if the working tree is dirty.
 * Returns true if a stash was created, false if the tree was already clean.
 */
export async function stashIfDirty(projectPath: string): Promise<boolean> {
  const clean = await isCleanBranch(projectPath);
  if (clean) return false;

  await git(['stash', 'push', '-m', 'ivy-heartbeat: auto-stash before worktree'], projectPath);
  return true;
}

/**
 * Pop the most recent stash entry. Only call if stashIfDirty() returned true.
 * Non-fatal: logs but does not throw on failure.
 */
export async function popStash(projectPath: string): Promise<boolean> {
  try {
    await git(['stash', 'pop'], projectPath);
    return true;
  } catch {
    // Stash pop can fail if there are conflicts — leave stash intact
    // User can resolve manually with `git stash pop` or `git stash drop`
    return false;
  }
}

/**
 * Get the current branch name.
 */
export async function getCurrentBranch(projectPath: string): Promise<string> {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], projectPath);
}

// ─── Worktree lifecycle ───────────────────────────────────────────────────

/**
 * Create a git worktree for the given branch.
 * If the branch already exists locally or remotely, deletes it first.
 * Returns the worktree path.
 */
export async function createWorktree(
  projectPath: string,
  branch: string,
  projectId?: string
): Promise<string> {
  const dirName = projectId ?? projectPath.split('/').pop() ?? 'unknown';
  const worktreePath = join(worktreeBaseDir(), dirName, branch);

  // Ensure parent directory exists
  mkdirSync(join(worktreeBaseDir(), dirName), { recursive: true });

  // Guard: do not delete branch if a review/rework cycle is active for it.
  // Deleting the remote branch would close the associated PR.
  const reviewCycleActive = hasActiveReviewCycle(branch);

  // Clean up stale worktree if path exists
  if (existsSync(worktreePath)) {
    try {
      await git(['worktree', 'remove', '--force', worktreePath], projectPath);
    } catch {
      // If worktree remove fails, the directory may be orphaned — try pruning
      await git(['worktree', 'prune'], projectPath);
    }
  }

  if (!reviewCycleActive) {
    // Delete local branch if it exists
    try {
      await git(['branch', '-D', branch], projectPath);
    } catch {
      // Branch doesn't exist locally — that's fine
    }

    // Delete remote branch if it exists
    try {
      await git(['push', 'origin', '--delete', branch], projectPath);
    } catch {
      // Remote branch doesn't exist — that's fine
    }
  }

  // Fetch latest from origin to ensure we branch from up-to-date main
  try {
    await git(['fetch', 'origin'], projectPath);
  } catch {
    // Fetch may fail if no remote configured — continue anyway
  }

  // Create worktree with new branch (reuse existing branch if review cycle is active)
  if (reviewCycleActive) {
    // Branch exists — create worktree using existing branch (no -b flag)
    try {
      await git(['worktree', 'add', worktreePath, branch], projectPath);
    } catch {
      // Branch may not exist after all — create new
      await git(['worktree', 'add', '-b', branch, worktreePath], projectPath);
    }
  } else {
    await git(['worktree', 'add', '-b', branch, worktreePath], projectPath);
  }

  return worktreePath;
}

/**
 * Remove a worktree. Always safe to call (logs but doesn't throw).
 */
export async function removeWorktree(
  projectPath: string,
  worktreePath: string
): Promise<void> {
  try {
    await git(['worktree', 'remove', '--force', worktreePath], projectPath);
  } catch {
    // Best effort — prune stale entries
    try {
      await git(['worktree', 'prune'], projectPath);
    } catch {
      // Truly orphaned — manual cleanup needed
    }
  }
}

/**
 * Ensure a worktree exists at the given path and is valid.
 * If the worktree exists and is registered in git, reuses it.
 * Otherwise, prunes stale entries and creates a fresh worktree.
 */
export async function ensureWorktree(
  projectPath: string,
  worktreePath: string,
  branch: string
): Promise<string> {
  // Check if directory exists
  if (existsSync(worktreePath)) {
    // Verify it's a registered worktree
    try {
      const list = await git(['worktree', 'list', '--porcelain'], projectPath);
      if (list.includes(worktreePath)) {
        return worktreePath; // Valid, reuse it
      }
    } catch {
      // git worktree list failed — fall through to recreate
    }

    // Directory exists but not a valid worktree — clean up
    try {
      await git(['worktree', 'remove', '--force', worktreePath], projectPath);
    } catch {
      await git(['worktree', 'prune'], projectPath);
    }
  }

  // Ensure parent directory exists
  const { dirname } = await import('node:path');
  mkdirSync(dirname(worktreePath), { recursive: true });

  // Try to create with existing branch first (may exist from prior phase)
  try {
    await git(['worktree', 'add', worktreePath, branch], projectPath);
    return worktreePath;
  } catch {
    // Branch may not exist — create new
  }

  await git(['worktree', 'add', '-b', branch, worktreePath], projectPath);
  return worktreePath;
}

// ─── Branch helpers ──────────────────────────────────────────────────────

/**
 * Ensure the worktree is on the expected branch.
 * If the worktree is on a different branch, checkout the expected one.
 * Handles errors gracefully (branch not found, uncommitted changes).
 */
export async function ensureBranch(
  worktreePath: string,
  branch: string
): Promise<void> {
  const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
  if (current === branch) return;
  await git(['checkout', branch], worktreePath);
}

// ─── Post-agent git operations ────────────────────────────────────────────

/**
 * Stage all changes and commit. Returns the commit SHA, or null if
 * there was nothing to commit.
 */
export async function commitAll(
  worktreePath: string,
  message: string
): Promise<string | null> {
  // Stage everything
  await git(['add', '-A'], worktreePath);

  // Check if there's anything to commit
  const status = await git(['status', '--porcelain'], worktreePath);
  if (status.length === 0) {
    return null; // Nothing to commit
  }

  await git(['commit', '-m', message], worktreePath);
  const sha = await git(['rev-parse', 'HEAD'], worktreePath);
  return sha;
}

/**
 * Push the branch to origin.
 */
export async function pushBranch(
  worktreePath: string,
  branch: string
): Promise<void> {
  await git(['push', '-u', 'origin', branch], worktreePath);
}

/**
 * Create a pull request and return the PR number and URL.
 */
export async function createPR(
  worktreePath: string,
  title: string,
  body: string,
  base: string
): Promise<{ number: number; url: string }> {
  // gh pr create outputs the PR URL to stdout (no --json support)
  const url = await gh(
    [
      'pr', 'create',
      '--title', title,
      '--body', body,
      '--base', base,
    ],
    worktreePath
  );

  // Extract PR number from URL: https://github.com/owner/repo/pull/123
  const match = url.match(/\/pull\/(\d+)$/);
  const number = match ? parseInt(match[1], 10) : 0;
  return { number, url };
}

// ─── Merge-fix helpers ────────────────────────────────────────────────────

/**
 * Rebase the current branch on top of the given base branch.
 * Returns true if rebase succeeds cleanly, false if there are conflicts.
 */
export async function rebaseOnMain(
  worktreePath: string,
  mainBranch: string
): Promise<boolean> {
  // Fetch latest first
  try {
    await git(['fetch', 'origin'], worktreePath);
  } catch {
    // May fail if no remote — continue with local
  }

  try {
    await git(['rebase', `origin/${mainBranch}`], worktreePath);
    return true;
  } catch {
    // Check if we're mid-rebase with conflicts
    const conflicted = await getConflictedFiles(worktreePath);
    if (conflicted.length > 0) {
      // Abort the rebase so the caller can decide what to do
      try {
        await git(['rebase', '--abort'], worktreePath);
      } catch {
        // Best effort abort
      }
    }
    return false;
  }
}

/**
 * Force-push the current branch to origin.
 * Used after a successful rebase to update the PR branch.
 */
export async function forcePushBranch(
  worktreePath: string,
  branch: string
): Promise<void> {
  await git(['push', '--force-with-lease', 'origin', branch], worktreePath);
}

/**
 * Get the list of files with merge conflicts.
 * Returns an empty array if no conflicts.
 */
export async function getConflictedFiles(
  worktreePath: string
): Promise<string[]> {
  try {
    const output = await git(['diff', '--name-only', '--diff-filter=U'], worktreePath);
    if (!output) return [];
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Post-agent merge & sync ──────────────────────────────────────────────

/**
 * Squash-merge a pull request via gh CLI.
 * Returns true if the merge succeeded, false otherwise (non-fatal).
 */
export async function mergePR(
  worktreePath: string,
  prNumber: number
): Promise<boolean> {
  try {
    await gh(
      ['pr', 'merge', String(prNumber), '--squash', '--delete-branch'],
      worktreePath
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Check the state of a PR via gh CLI.
 * Returns 'MERGED', 'OPEN', 'CLOSED', or null if the check fails.
 */
export async function getPRState(
  cwd: string,
  prNumber: number
): Promise<'MERGED' | 'OPEN' | 'CLOSED' | null> {
  try {
    const raw = await gh(
      ['pr', 'view', String(prNumber), '--json', 'state', '--jq', '.state'],
      cwd
    );
    const state = raw.trim().toUpperCase();
    if (state === 'MERGED' || state === 'OPEN' || state === 'CLOSED') {
      return state;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Pull latest changes into the main repo from origin.
 * Used after merging a PR so the local main branch stays in sync.
 */
export async function pullMain(
  projectPath: string,
  branch: string
): Promise<void> {
  await git(['pull', 'origin', branch], projectPath);
}

// ─── Post-agent issue comment support ─────────────────────────────────────

/**
 * Get a diff summary (--stat) between base and the current branch.
 */
export async function getDiffSummary(
  worktreePath: string,
  base: string
): Promise<string> {
  return git(['diff', '--stat', `${base}...HEAD`], worktreePath);
}

/**
 * Build the prompt for the commenter agent that will post an issue comment.
 */
export function buildCommentPrompt(
  issue: { number: number; title: string; body?: string; author: string },
  prUrl: string,
  diffSummary: string
): string {
  return [
    `You are writing a comment on GitHub issue #${issue.number}: "${issue.title}"`,
    `Opened by: ${issue.author}`,
    '',
    issue.body ? `Issue body:\n${issue.body}\n` : '',
    `A fix has been submitted as a pull request: ${prUrl}`,
    '',
    'Changes summary:',
    diffSummary,
    '',
    'Write a helpful, concise comment (2-4 sentences) for the issue that:',
    '1. Briefly explains what was done to address the issue',
    '2. References the PR',
    '3. Is professional and friendly',
    '',
    `Post the comment using: gh issue comment ${issue.number} --body "<your comment>"`,
    '',
    'Do not do anything else. Just write and post the comment.',
  ].filter(Boolean).join('\n');
}
