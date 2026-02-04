import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isCleanBranch,
  getCurrentBranch,
  createWorktree,
  removeWorktree,
  commitAll,
  buildCommentPrompt,
} from '../src/scheduler/worktree.ts';

/**
 * Initialize a real git repo in a temp directory with an initial commit.
 */
async function initTestRepo(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), 'hb-worktree-'));

  const run = async (args: string[]) => {
    const proc = Bun.spawn(['git', ...args], {
      cwd: repoDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });
    await proc.exited;
    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`git ${args[0]} failed: ${stderr}`);
    }
  };

  await run(['init', '-b', 'main']);
  await run(['config', 'user.email', 'test@test.com']);
  await run(['config', 'user.name', 'Test']);

  // Create initial commit
  writeFileSync(join(repoDir, 'README.md'), '# Test\n');
  await run(['add', 'README.md']);
  await run(['commit', '-m', 'Initial commit']);

  return repoDir;
}

describe('isCleanBranch', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await initTestRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test('returns true on clean repo', async () => {
    expect(await isCleanBranch(repoDir)).toBe(true);
  });

  test('returns false with uncommitted changes', async () => {
    writeFileSync(join(repoDir, 'dirty.txt'), 'uncommitted');
    expect(await isCleanBranch(repoDir)).toBe(false);
  });

  test('returns false with staged but uncommitted changes', async () => {
    writeFileSync(join(repoDir, 'staged.txt'), 'staged');
    const proc = Bun.spawn(['git', 'add', 'staged.txt'], { cwd: repoDir });
    await proc.exited;
    expect(await isCleanBranch(repoDir)).toBe(false);
  });
});

describe('getCurrentBranch', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await initTestRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test('returns main for default branch', async () => {
    expect(await getCurrentBranch(repoDir)).toBe('main');
  });
});

describe('createWorktree', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await initTestRepo();
  });

  afterEach(async () => {
    // Clean up any worktrees first
    const proc = Bun.spawn(['git', 'worktree', 'list', '--porcelain'], {
      cwd: repoDir,
      stdout: 'pipe',
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;

    // Remove non-main worktrees
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ') && !line.includes(repoDir)) {
        const path = line.replace('worktree ', '');
        try {
          const rm = Bun.spawn(['git', 'worktree', 'remove', '--force', path], { cwd: repoDir });
          await rm.exited;
        } catch { /* best effort */ }
      }
    }

    rmSync(repoDir, { recursive: true, force: true });
  });

  test('creates a worktree directory with correct branch', async () => {
    const worktreePath = await createWorktree(repoDir, 'fix/issue-42', 'test-project');

    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(join(worktreePath, 'README.md'))).toBe(true);

    // Check the branch name in the worktree
    const proc = Bun.spawn(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
      stdout: 'pipe',
    });
    const branch = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(branch).toBe('fix/issue-42');

    // Cleanup
    await removeWorktree(repoDir, worktreePath);
  });

  test('handles existing branch by recreating', async () => {
    // Create and remove a worktree to leave a stale branch
    const path1 = await createWorktree(repoDir, 'fix/issue-99', 'test-project');
    await removeWorktree(repoDir, path1);

    // Should succeed even though branch exists from previous run
    const path2 = await createWorktree(repoDir, 'fix/issue-99', 'test-project');
    expect(existsSync(path2)).toBe(true);

    await removeWorktree(repoDir, path2);
  });
});

describe('removeWorktree', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await initTestRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test('removes an existing worktree', async () => {
    const worktreePath = await createWorktree(repoDir, 'fix/issue-10', 'test-project');
    expect(existsSync(worktreePath)).toBe(true);

    await removeWorktree(repoDir, worktreePath);
    expect(existsSync(worktreePath)).toBe(false);
  });

  test('does not throw for non-existent worktree', async () => {
    // Should not throw
    await removeWorktree(repoDir, '/tmp/nonexistent-worktree-path');
  });
});

describe('commitAll', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await initTestRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test('commits changes and returns sha', async () => {
    writeFileSync(join(repoDir, 'new-file.txt'), 'content');
    const sha = await commitAll(repoDir, 'Add new file');

    expect(sha).toBeTruthy();
    expect(sha!.length).toBeGreaterThanOrEqual(7);

    // Verify the commit exists
    const proc = Bun.spawn(['git', 'log', '--oneline', '-1'], {
      cwd: repoDir,
      stdout: 'pipe',
    });
    const log = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    expect(log).toContain('Add new file');
  });

  test('returns null when no changes to commit', async () => {
    const sha = await commitAll(repoDir, 'Empty commit');
    expect(sha).toBeNull();
  });
});

describe('buildCommentPrompt', () => {
  test('includes issue number and PR URL', () => {
    const prompt = buildCommentPrompt(
      { number: 42, title: 'Fix bug', body: 'The bug is bad', author: 'alice' },
      'https://github.com/owner/repo/pull/1',
      ' src/foo.ts | 5 +++--\n 1 file changed'
    );

    expect(prompt).toContain('#42');
    expect(prompt).toContain('Fix bug');
    expect(prompt).toContain('https://github.com/owner/repo/pull/1');
    expect(prompt).toContain('alice');
    expect(prompt).toContain('src/foo.ts');
  });

  test('handles missing body', () => {
    const prompt = buildCommentPrompt(
      { number: 1, title: 'Title', author: 'bob' },
      'https://github.com/o/r/pull/2',
      '0 files changed'
    );

    expect(prompt).toContain('#1');
    expect(prompt).not.toContain('Issue body:');
  });
});
