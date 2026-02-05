import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, cleanupTestContext, type TestContext } from './helpers.ts';
import {
  evaluateGithubIssueWatcher,
  setIssueStatusFetcher,
  resetIssueStatusFetcher,
  setWatcherBlackboardAccessor,
  resetWatcherBlackboardAccessor,
  type WatchedIssueStatus,
  type WatcherBlackboardAccessor,
} from '../src/evaluators/github-issue-watcher.ts';
import type { ChecklistItem } from '../src/parser/types.ts';

// ─── Factories ────────────────────────────────────────────────────────────

function makeItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    name: 'Issue Watcher',
    type: 'github_issue_watcher',
    severity: 'low',
    channels: ['terminal'],
    enabled: true,
    description: 'Watch cross-project GitHub issues for activity',
    config: {},
    ...overrides,
  };
}

function makeWaitingMetadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    waiting_type: 'github_issue',
    watched_repo: 'owner/other-project',
    watched_issue: 42,
    watched_since: '2026-02-01T10:00:00Z',
    last_checked_at: '2026-02-05T10:00:00Z',
    originating_item_id: 'gh-my-project-7',
    originating_project: 'my-project',
    resume_context: 'Need the new API endpoint in other-project to continue',
    on_close: 'continue_work',
    on_comment: 'evaluate_and_respond',
    ...overrides,
  });
}

function makeOpenIssueStatus(comments: WatchedIssueStatus['comments'] = []): WatchedIssueStatus {
  return {
    number: 42,
    state: 'OPEN',
    comments,
  };
}

function makeClosedIssueStatus(comments: WatchedIssueStatus['comments'] = []): WatchedIssueStatus {
  return {
    number: 42,
    state: 'CLOSED',
    comments,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('evaluateGithubIssueWatcher', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    resetIssueStatusFetcher();
    resetWatcherBlackboardAccessor();
    cleanupTestContext(ctx);
  });

  test('returns error when blackboard not configured', async () => {
    const result = await evaluateGithubIssueWatcher(makeItem());
    expect(result.status).toBe('error');
    expect(result.summary).toContain('blackboard not configured');
  });

  test('returns ok when no items being watched', async () => {
    setWatcherBlackboardAccessor({
      listWorkItems: () => [],
      createWorkItem: () => {},
      completeWaitingItem: () => {},
      unblockWorkItem: () => {},
      updateWorkItemMetadata: () => {},
    });

    const result = await evaluateGithubIssueWatcher(makeItem());
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('no issues being watched');
    expect(result.details).toEqual({
      watchedCount: 0,
      closedCount: 0,
      commentCount: 0,
    });
  });

  test('skips items without github_issue waiting_type', async () => {
    setWatcherBlackboardAccessor({
      listWorkItems: () => [
        {
          item_id: 'watch-1',
          project_id: null,
          title: 'Some other waiting item',
          description: null,
          source: 'local',
          source_ref: null,
          status: 'waiting_for_response' as any,
          priority: 'P2' as const,
          claimed_by: null,
          claimed_at: null,
          completed_at: null,
          blocked_by: null,
          created_at: '2026-02-01T10:00:00Z',
          metadata: JSON.stringify({ waiting_type: 'email' }),
        },
      ],
      createWorkItem: () => {},
      completeWaitingItem: () => {},
      unblockWorkItem: () => {},
      updateWorkItemMetadata: () => {},
    });

    const result = await evaluateGithubIssueWatcher(makeItem());
    expect(result.status).toBe('ok');
    expect(result.details?.watchedCount).toBe(0);
  });

  test('detects issue closure and creates continuation work item', async () => {
    const createdItems: Array<Record<string, unknown>> = [];
    const completedItems: string[] = [];
    const unblockedItems: string[] = [];
    const metadataUpdates: Array<{ id: string; updates: Record<string, unknown> }> = [];

    setWatcherBlackboardAccessor({
      listWorkItems: () => [
        {
          item_id: 'watch-dep-42',
          project_id: 'my-project',
          title: 'Watching owner/other-project#42',
          description: null,
          source: 'github',
          source_ref: 'https://github.com/owner/other-project/issues/42',
          status: 'waiting_for_response' as any,
          priority: 'P2' as const,
          claimed_by: null,
          claimed_at: null,
          completed_at: null,
          blocked_by: null,
          created_at: '2026-02-01T10:00:00Z',
          metadata: makeWaitingMetadata(),
        },
      ],
      createWorkItem: (opts) => { createdItems.push(opts); },
      completeWaitingItem: (id) => { completedItems.push(id); },
      unblockWorkItem: (id) => { unblockedItems.push(id); },
      updateWorkItemMetadata: (id, updates) => { metadataUpdates.push({ id, updates }); },
    });

    setIssueStatusFetcher(async () => makeClosedIssueStatus([
      {
        author: { login: 'contributor' },
        body: 'Fixed the API endpoint',
        createdAt: '2026-02-05T12:00:00Z',
      },
    ]));

    const result = await evaluateGithubIssueWatcher(makeItem());
    expect(result.status).toBe('alert');
    expect(result.details?.closedCount).toBe(1);
    expect(result.summary).toContain('1 resolved');

    // Continuation work item was created
    expect(createdItems.length).toBe(1);
    expect(createdItems[0].title).toContain('Resume:');
    expect(createdItems[0].title).toContain('gh-my-project-7');
    expect(createdItems[0].priority).toBe('P1');
    expect(createdItems[0].project).toBe('my-project');
    const contDesc = createdItems[0].description as string;
    expect(contDesc).toContain('Cross-Project Dependency Resolved');
    expect(contDesc).toContain('Resume Context');
    expect(contDesc).toContain('Need the new API endpoint');
    expect(contDesc).toContain('Fixed the API endpoint');

    // Original work item was unblocked
    expect(unblockedItems).toContain('gh-my-project-7');

    // Watcher item was completed
    expect(completedItems).toContain('watch-dep-42');

    // Metadata was updated
    const watcherUpdate = metadataUpdates.find((u) => u.id === 'watch-dep-42');
    expect(watcherUpdate?.updates.resolution).toBe('issue_closed');
  });

  test('detects new comments and creates response work items', async () => {
    const createdItems: Array<Record<string, unknown>> = [];
    const metadataUpdates: Array<{ id: string; updates: Record<string, unknown> }> = [];

    setWatcherBlackboardAccessor({
      listWorkItems: () => [
        {
          item_id: 'watch-dep-42',
          project_id: 'my-project',
          title: 'Watching owner/other-project#42',
          description: null,
          source: 'github',
          source_ref: 'https://github.com/owner/other-project/issues/42',
          status: 'waiting_for_response' as any,
          priority: 'P2' as const,
          claimed_by: null,
          claimed_at: null,
          completed_at: null,
          blocked_by: null,
          created_at: '2026-02-01T10:00:00Z',
          metadata: makeWaitingMetadata({ last_checked_at: '2026-02-05T10:00:00Z' }),
        },
      ],
      createWorkItem: (opts) => { createdItems.push(opts); },
      completeWaitingItem: () => {},
      unblockWorkItem: () => {},
      updateWorkItemMetadata: (id, updates) => { metadataUpdates.push({ id, updates }); },
    });

    setIssueStatusFetcher(async () => makeOpenIssueStatus([
      // Old comment (before last_checked_at)
      {
        author: { login: 'old-commenter' },
        body: 'Old comment',
        createdAt: '2026-02-04T10:00:00Z',
      },
      // New comment (after last_checked_at)
      {
        author: { login: 'new-commenter' },
        body: 'I can help with this!',
        createdAt: '2026-02-05T14:00:00Z',
      },
    ]));

    const result = await evaluateGithubIssueWatcher(makeItem());
    expect(result.status).toBe('alert');
    expect(result.details?.commentCount).toBe(1);
    expect(result.summary).toContain('1 new comment(s)');

    // Only the new comment generated a response work item
    expect(createdItems.length).toBe(1);
    expect(createdItems[0].title).toContain('Review comment');
    expect(createdItems[0].title).toContain('new-commenter');
    const respDesc = createdItems[0].description as string;
    expect(respDesc).toContain('I can help with this!');
    expect(respDesc).toContain('Context');

    // last_checked_at was updated
    const watcherUpdate = metadataUpdates.find((u) => u.id === 'watch-dep-42');
    expect(watcherUpdate?.updates.last_checked_at).toBeDefined();
  });

  test('returns ok when no new activity on watched issues', async () => {
    const metadataUpdates: Array<{ id: string; updates: Record<string, unknown> }> = [];

    setWatcherBlackboardAccessor({
      listWorkItems: () => [
        {
          item_id: 'watch-dep-42',
          project_id: 'my-project',
          title: 'Watching owner/other-project#42',
          description: null,
          source: 'github',
          source_ref: 'https://github.com/owner/other-project/issues/42',
          status: 'waiting_for_response' as any,
          priority: 'P2' as const,
          claimed_by: null,
          claimed_at: null,
          completed_at: null,
          blocked_by: null,
          created_at: '2026-02-01T10:00:00Z',
          metadata: makeWaitingMetadata({ last_checked_at: '2026-02-05T15:00:00Z' }),
        },
      ],
      createWorkItem: () => {},
      completeWaitingItem: () => {},
      unblockWorkItem: () => {},
      updateWorkItemMetadata: (id, updates) => { metadataUpdates.push({ id, updates }); },
    });

    // Issue is open with only old comments
    setIssueStatusFetcher(async () => makeOpenIssueStatus([
      {
        author: { login: 'someone' },
        body: 'Some old discussion',
        createdAt: '2026-02-04T10:00:00Z',
      },
    ]));

    const result = await evaluateGithubIssueWatcher(makeItem());
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('no new activity');
    expect(result.details?.watchedCount).toBe(1);

    // last_checked_at should still be updated
    expect(metadataUpdates.length).toBe(1);
    expect(metadataUpdates[0].updates.last_checked_at).toBeDefined();
  });

  test('handles fetch failure gracefully', async () => {
    setWatcherBlackboardAccessor({
      listWorkItems: () => [
        {
          item_id: 'watch-dep-99',
          project_id: 'my-project',
          title: 'Watching owner/other-project#99',
          description: null,
          source: 'github',
          source_ref: null,
          status: 'waiting_for_response' as any,
          priority: 'P2' as const,
          claimed_by: null,
          claimed_at: null,
          completed_at: null,
          blocked_by: null,
          created_at: '2026-02-01T10:00:00Z',
          metadata: makeWaitingMetadata({ watched_issue: 99 }),
        },
      ],
      createWorkItem: () => {},
      completeWaitingItem: () => {},
      unblockWorkItem: () => {},
      updateWorkItemMetadata: () => {},
    });

    // Fetcher returns null (failure)
    setIssueStatusFetcher(async () => null);

    const result = await evaluateGithubIssueWatcher(makeItem());
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('no new activity');
  });

  test('handles multiple watched issues in parallel', async () => {
    const createdItems: Array<Record<string, unknown>> = [];

    setWatcherBlackboardAccessor({
      listWorkItems: () => [
        {
          item_id: 'watch-dep-42',
          project_id: 'project-a',
          title: 'Watching owner/repo-a#42',
          description: null,
          source: 'github',
          source_ref: null,
          status: 'waiting_for_response' as any,
          priority: 'P2' as const,
          claimed_by: null,
          claimed_at: null,
          completed_at: null,
          blocked_by: null,
          created_at: '2026-02-01T10:00:00Z',
          metadata: makeWaitingMetadata({
            watched_repo: 'owner/repo-a',
            watched_issue: 42,
            originating_item_id: 'gh-project-a-1',
            originating_project: 'project-a',
          }),
        },
        {
          item_id: 'watch-dep-77',
          project_id: 'project-b',
          title: 'Watching owner/repo-b#77',
          description: null,
          source: 'github',
          source_ref: null,
          status: 'waiting_for_response' as any,
          priority: 'P2' as const,
          claimed_by: null,
          claimed_at: null,
          completed_at: null,
          blocked_by: null,
          created_at: '2026-02-01T10:00:00Z',
          metadata: makeWaitingMetadata({
            watched_repo: 'owner/repo-b',
            watched_issue: 77,
            originating_item_id: 'gh-project-b-5',
            originating_project: 'project-b',
          }),
        },
      ],
      createWorkItem: (opts) => { createdItems.push(opts); },
      completeWaitingItem: () => {},
      unblockWorkItem: () => {},
      updateWorkItemMetadata: () => {},
    });

    // First issue closed, second still open
    setIssueStatusFetcher(async (repo, num) => {
      if (num === 42) return makeClosedIssueStatus();
      return makeOpenIssueStatus();
    });

    const result = await evaluateGithubIssueWatcher(makeItem());
    expect(result.status).toBe('alert');
    expect(result.details?.closedCount).toBe(1);
    expect(result.details?.watchedCount).toBe(2);

    // Only one continuation (for the closed issue)
    expect(createdItems.length).toBe(1);
    expect(createdItems[0].project).toBe('project-a');
  });

  test('continuation metadata includes resolution details', async () => {
    const createdItems: Array<Record<string, unknown>> = [];

    setWatcherBlackboardAccessor({
      listWorkItems: () => [
        {
          item_id: 'watch-dep-42',
          project_id: 'my-project',
          title: 'Watching owner/repo#42',
          description: null,
          source: 'github',
          source_ref: null,
          status: 'waiting_for_response' as any,
          priority: 'P2' as const,
          claimed_by: null,
          claimed_at: null,
          completed_at: null,
          blocked_by: null,
          created_at: '2026-02-01T10:00:00Z',
          metadata: makeWaitingMetadata(),
        },
      ],
      createWorkItem: (opts) => { createdItems.push(opts); },
      completeWaitingItem: () => {},
      unblockWorkItem: () => {},
      updateWorkItemMetadata: () => {},
    });

    setIssueStatusFetcher(async () => makeClosedIssueStatus());

    await evaluateGithubIssueWatcher(makeItem());

    expect(createdItems.length).toBe(1);
    const meta = JSON.parse(createdItems[0].metadata as string);
    expect(meta.continuation_of).toBe('gh-my-project-7');
    expect(meta.resolved_issue).toBe('owner/other-project#42');
    expect(meta.resolution_type).toBe('issue_closed');
    expect(meta.resolved_at).toBeDefined();
  });

  test('handles errors from evaluator gracefully', async () => {
    setWatcherBlackboardAccessor({
      listWorkItems: () => { throw new Error('DB connection failed'); },
      createWorkItem: () => {},
      completeWaitingItem: () => {},
      unblockWorkItem: () => {},
      updateWorkItemMetadata: () => {},
    });

    const result = await evaluateGithubIssueWatcher(makeItem());
    expect(result.status).toBe('error');
    expect(result.summary).toContain('DB connection failed');
  });

  test('handles items with invalid metadata gracefully', async () => {
    setWatcherBlackboardAccessor({
      listWorkItems: () => [
        {
          item_id: 'watch-bad',
          project_id: null,
          title: 'Bad metadata',
          description: null,
          source: 'local',
          source_ref: null,
          status: 'waiting_for_response' as any,
          priority: 'P2' as const,
          claimed_by: null,
          claimed_at: null,
          completed_at: null,
          blocked_by: null,
          created_at: '2026-02-01T10:00:00Z',
          metadata: 'not valid json{{{',
        },
      ],
      createWorkItem: () => {},
      completeWaitingItem: () => {},
      unblockWorkItem: () => {},
      updateWorkItemMetadata: () => {},
    });

    const result = await evaluateGithubIssueWatcher(makeItem());
    expect(result.status).toBe('ok');
    expect(result.details?.watchedCount).toBe(0);
  });
});

describe('waiting_for_response status in blackboard', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    cleanupTestContext(ctx);
  });

  test('can create work items with waiting_for_response status via setWaitingForResponse', () => {
    // First create a normal work item
    ctx.bb.createWorkItem({
      id: 'test-item-1',
      title: 'Test work item',
      source: 'github',
      priority: 'P2',
    });

    // Set it to waiting_for_response
    ctx.bb.setWaitingForResponse('test-item-1', { blockedBy: 'watch-dep-42' });

    // Verify it's now waiting
    const items = ctx.bb.listWorkItems({ status: 'waiting_for_response' });
    expect(items.length).toBe(1);
    expect(items[0].item_id).toBe('test-item-1');
    expect(items[0].status).toBe('waiting_for_response');
    expect(items[0].blocked_by).toBe('watch-dep-42');
  });

  test('waiting_for_response items are NOT returned by default listWorkItems', () => {
    ctx.bb.createWorkItem({
      id: 'available-item',
      title: 'Available item',
      source: 'github',
    });
    ctx.bb.createWorkItem({
      id: 'waiting-item',
      title: 'Waiting item',
      source: 'github',
    });
    ctx.bb.setWaitingForResponse('waiting-item');

    // Default query returns only available
    const defaultItems = ctx.bb.listWorkItems();
    expect(defaultItems.length).toBe(1);
    expect(defaultItems[0].item_id).toBe('available-item');
  });

  test('completeWaitingItem completes a waiting_for_response item', () => {
    ctx.bb.createWorkItem({
      id: 'waiting-item',
      title: 'Waiting for dependency',
      source: 'github',
    });
    ctx.bb.setWaitingForResponse('waiting-item');

    ctx.bb.completeWaitingItem('waiting-item');

    const items = ctx.bb.listWorkItems({ all: true, status: 'completed' });
    const completed = items.find((i) => i.item_id === 'waiting-item');
    expect(completed).toBeDefined();
    expect(completed!.status).toBe('completed');
    expect(completed!.completed_at).toBeDefined();
  });

  test('completeWaitingItem is a no-op for non-waiting items', () => {
    ctx.bb.createWorkItem({
      id: 'available-item',
      title: 'Available item',
      source: 'github',
    });

    // Should not throw, just no-op
    ctx.bb.completeWaitingItem('available-item');

    // Item should still be available
    const items = ctx.bb.listWorkItems();
    expect(items.length).toBe(1);
    expect(items[0].status).toBe('available');
  });

  test('unblockWorkItem works with waiting_for_response items', () => {
    ctx.bb.createWorkItem({
      id: 'waiting-item',
      title: 'Waiting item',
      source: 'github',
    });
    ctx.bb.setWaitingForResponse('waiting-item', { blockedBy: 'dep-42' });

    // Unblock restores to available (no claimed_by)
    const result = ctx.bb.unblockWorkItem('waiting-item');
    expect(result.unblocked).toBe(true);
    expect(result.restored_status).toBe('available');

    const items = ctx.bb.listWorkItems();
    expect(items.length).toBe(1);
    expect(items[0].status).toBe('available');
  });
});
