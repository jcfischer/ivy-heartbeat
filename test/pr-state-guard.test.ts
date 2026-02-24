import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { createTestContext, cleanupTestContext, type TestContext } from './helpers.ts';
import { registerProject } from 'ivy-blackboard/src/project';
import { createWorkItem } from 'ivy-blackboard/src/work';
import type { ReworkMetadata } from '../src/scheduler/rework.ts';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  cleanupTestContext(ctx);
  mock.restore();
});

// ─── Shared worktree mock ─────────────────────────────────────────────────

const allWorktreeExports = {
  stashIfDirty: async () => false,
  popStash: async () => false,
  createWorktree: async () => '/tmp/wt',
  removeWorktree: async () => {},
  resolveWorktreePath: () => '/tmp/wt',
  commitAll: async () => 'abc123',
  pushBranch: async () => {},
  getPRState: async () => 'OPEN',
  reopenPR: async () => true,
  remoteBranchExists: async () => true,
  createPR: async () => ({ number: 99, url: 'https://github.com/o/r/pull/99' }),
  mergePR: async () => true,
  pullMain: async () => {},
  ensureWorktree: async () => '/tmp/wt',
  isCleanBranch: async () => true,
  getCurrentBranch: async () => 'main',
  rebaseOnMain: async () => true,
  forcePushBranch: async () => {},
  getConflictedFiles: async () => [],
  getDiffSummary: async () => '',
  buildCommentPrompt: () => '',
};

// ─── runRework PR state guards ────────────────────────────────────────────

describe('runRework — PR state guards', () => {
  const baseMeta: ReworkMetadata = {
    rework: true,
    pr_number: 24,
    pr_url: 'https://github.com/o/r/pull/24',
    repo: 'o/r',
    branch: 'specflow-f-020',
    main_branch: 'main',
    implementation_work_item_id: 'gh-r-20',
    review_feedback: 'Fix the SQL injection',
    rework_cycle: 1,
    project_id: 'proj-a',
  };

  function setupWorkItem() {
    registerProject(ctx.bb.db, { id: 'proj-a', name: 'Project A', path: '/tmp/proj-a' });
    createWorkItem(ctx.bb.db, {
      id: 'rework-proj-a-pr-24-cycle-1',
      title: 'Rework: PR #24 - Fix auth (cycle 1)',
      project: 'proj-a',
      source: 'rework',
      metadata: JSON.stringify(baseMeta),
    });
    return ctx.bb.listWorkItems()[0];
  }

  function mockWorktree(overrides: Record<string, any>) {
    mock.module('../src/scheduler/worktree.ts', () => ({
      ...allWorktreeExports,
      ...overrides,
    }));
  }

  test('skips rework when PR is already merged', async () => {
    mockWorktree({ getPRState: async () => 'MERGED' });
    const { runRework } = await import('../src/scheduler/rework.ts');

    const item = setupWorkItem();
    const mockLauncher = async () => ({ stdout: '', exitCode: 0 });

    await runRework(
      ctx.bb, item, { ...baseMeta },
      { id: 'proj-a', name: 'Project A', local_path: '/tmp/proj-a' } as any,
      'session-1', mockLauncher as any, 60000,
    );

    // Should log "already merged" event
    const events = ctx.bb.eventQueries.getRecent(10);
    const mergedEvent = events.find((e: any) => e.summary.includes('already merged'));
    expect(mergedEvent).toBeDefined();
    expect(mergedEvent!.summary).toContain('PR #24 already merged');
  });

  test('reopens closed PR when branch still exists', async () => {
    mockWorktree({
      getPRState: async () => 'CLOSED',
      remoteBranchExists: async () => true,
      reopenPR: async () => true,
    });
    const { runRework } = await import('../src/scheduler/rework.ts');

    const item = setupWorkItem();
    const mockLauncher = async () => ({ stdout: 'done', exitCode: 0 });

    await runRework(
      ctx.bb, item, { ...baseMeta },
      { id: 'proj-a', name: 'Project A', local_path: '/tmp/proj-a' } as any,
      'session-1', mockLauncher as any, 60000,
    );

    const events = ctx.bb.eventQueries.getRecent(20);
    const reopenEvent = events.find((e: any) => e.summary.includes('Reopened closed PR'));
    expect(reopenEvent).toBeDefined();
    expect(reopenEvent!.summary).toContain('PR #24');
  });

  test('throws when PR is closed and reopen fails', async () => {
    mockWorktree({
      getPRState: async () => 'CLOSED',
      remoteBranchExists: async () => true,
      reopenPR: async () => false,
    });
    const { runRework } = await import('../src/scheduler/rework.ts');

    const item = setupWorkItem();
    const mockLauncher = async () => ({ stdout: '', exitCode: 0 });

    await expect(
      runRework(
        ctx.bb, item, { ...baseMeta },
        { id: 'proj-a', name: 'Project A', local_path: '/tmp/proj-a' } as any,
        'session-1', mockLauncher as any, 60000,
      )
    ).rejects.toThrow('could not be reopened');

    const events = ctx.bb.eventQueries.getRecent(10);
    const failEvent = events.find((e: any) => e.summary.includes('could not be reopened'));
    expect(failEvent).toBeDefined();
  });

  test('throws when PR closed, branch deleted, no worktree', async () => {
    mockWorktree({
      getPRState: async () => 'CLOSED',
      remoteBranchExists: async () => false,
      resolveWorktreePath: () => '/tmp/nonexistent-worktree-path',
    });
    const { runRework } = await import('../src/scheduler/rework.ts');

    const item = setupWorkItem();
    const mockLauncher = async () => ({ stdout: '', exitCode: 0 });

    await expect(
      runRework(
        ctx.bb, item, { ...baseMeta },
        { id: 'proj-a', name: 'Project A', local_path: '/tmp/proj-a' } as any,
        'session-1', mockLauncher as any, 60000,
      )
    ).rejects.toThrow('unrecoverable');

    const events = ctx.bb.eventQueries.getRecent(10);
    const blockedEvent = events.find((e: any) => e.summary.includes('requires manual intervention'));
    expect(blockedEvent).toBeDefined();
  });
});

// ─── dispatchReviewAgent PR state guards ──────────────────────────────────

describe('dispatchReviewAgent — PR state guards', () => {
  function setupReviewItem(): { item: any; sessionId: string } {
    registerProject(ctx.bb.db, { id: 'proj-a', name: 'Project A', path: '/tmp/proj-a' });
    createWorkItem(ctx.bb.db, {
      id: 'review-proj-a-pr-24',
      title: 'Code review: PR #24 - Fix auth',
      project: 'proj-a',
      source: 'code_review',
      metadata: JSON.stringify({
        pr_number: 24,
        pr_url: 'https://github.com/o/r/pull/24',
        repo: 'o/r',
        branch: 'specflow-f-020',
        main_branch: 'main',
      }),
    });
    // Register agent session (required by completeWorkItem)
    const agent = ctx.bb.registerAgent({
      name: 'test-review-agent',
      project: 'proj-a',
      work: 'review-proj-a-pr-24',
    });
    // Claim the work item (changes status from available to in_progress)
    ctx.bb.claimWorkItem('review-proj-a-pr-24', agent.session_id);
    // Use { all: true } to get the claimed item
    return { item: ctx.bb.listWorkItems({ all: true })[0], sessionId: agent.session_id };
  }

  function mockReviewDeps(prState: string) {
    mock.module('../src/scheduler/worktree.ts', () => ({
      ...allWorktreeExports,
      getPRState: async () => prState,
    }));
    mock.module('../src/scheduler/launcher.ts', () => ({
      getLauncher: () => async () => ({ stdout: '', exitCode: 0 }),
      logPathForSession: () => '/tmp/log',
    }));
  }

  test('skips review when PR is closed', async () => {
    mockReviewDeps('CLOSED');
    const { dispatchReviewAgent } = await import('../src/scheduler/review-agent.ts');

    const { item, sessionId } = setupReviewItem();

    const result = await dispatchReviewAgent(
      ctx.bb, item,
      { prNumber: 24, repo: 'o/r', branch: 'specflow-f-020', projectPath: '/tmp/proj-a' },
      sessionId, 60000,
    );

    expect(result.reviewStatus).toBe('skipped');
    expect(result.success).toBe(true);

    const events = ctx.bb.eventQueries.getRecent(10);
    const skipEvent = events.find((e: any) => e.summary.includes('Skipping review'));
    expect(skipEvent).toBeDefined();
    expect(skipEvent!.summary).toContain('closed');
  });

  test('skips review when PR is merged', async () => {
    mockReviewDeps('MERGED');
    const { dispatchReviewAgent } = await import('../src/scheduler/review-agent.ts');

    const { item, sessionId } = setupReviewItem();

    const result = await dispatchReviewAgent(
      ctx.bb, item,
      { prNumber: 24, repo: 'o/r', branch: 'specflow-f-020', projectPath: '/tmp/proj-a' },
      sessionId, 60000,
    );

    expect(result.reviewStatus).toBe('skipped');
    expect(result.success).toBe(true);

    const events = ctx.bb.eventQueries.getRecent(10);
    const skipEvent = events.find((e: any) => e.summary.includes('Skipping review'));
    expect(skipEvent).toBeDefined();
    expect(skipEvent!.summary).toContain('merged');
  });
});
