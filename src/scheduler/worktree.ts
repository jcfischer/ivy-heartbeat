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
  const home = process.env.HOME ?? '/tmp';
  return join(home, '.pai', 'worktrees');
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

  // Clean up stale worktree if path exists
  if (existsSync(worktreePath)) {
    try {
      await git(['worktree', 'remove', '--force', worktreePath], projectPath);
    } catch {
      // If worktree remove fails, the directory may be orphaned — try pruning
      await git(['worktree', 'prune'], projectPath);
    }
  }

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

  // Fetch latest from origin to ensure we branch from up-to-date main
  try {
    await git(['fetch', 'origin'], projectPath);
  } catch {
    // Fetch may fail if no remote configured — continue anyway
  }

  // Create worktree with new branch
  await git(['worktree', 'add', '-b', branch, worktreePath], projectPath);

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
  const output = await gh(
    [
      'pr', 'create',
      '--title', title,
      '--body', body,
      '--base', base,
      '--json', 'number,url',
    ],
    worktreePath
  );

  const result = JSON.parse(output);
  return { number: result.number, url: result.url };
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
