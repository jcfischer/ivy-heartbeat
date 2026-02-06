import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, cleanupTestContext, type TestContext } from './helpers.ts';
import {
  parseMergeFixMeta,
  createMergeFixWorkItem,
  type MergeFixMetadata,
} from '../src/scheduler/merge-fix.ts';
import { registerProject } from 'ivy-blackboard/src/project';
import { createWorkItem } from 'ivy-blackboard/src/work';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  cleanupTestContext(ctx);
});

describe('parseMergeFixMeta', () => {
  test('returns null for null metadata', () => {
    expect(parseMergeFixMeta(null)).toBeNull();
  });

  test('returns null for non-merge-fix metadata', () => {
    const meta = JSON.stringify({ github_issue_number: 1, github_repo: 'owner/repo' });
    expect(parseMergeFixMeta(meta)).toBeNull();
  });

  test('returns null for invalid JSON', () => {
    expect(parseMergeFixMeta('not json')).toBeNull();
  });

  test('returns null when merge_fix is not true', () => {
    const meta = JSON.stringify({ merge_fix: false, pr_number: 1, branch: 'b', main_branch: 'm' });
    expect(parseMergeFixMeta(meta)).toBeNull();
  });

  test('returns null when required fields are missing', () => {
    const meta = JSON.stringify({ merge_fix: true, pr_number: 1 });
    expect(parseMergeFixMeta(meta)).toBeNull();
  });

  test('parses valid merge-fix metadata', () => {
    const input: MergeFixMetadata = {
      merge_fix: true,
      pr_number: 42,
      pr_url: 'https://github.com/owner/repo/pull/42',
      branch: 'fix/issue-10',
      main_branch: 'main',
      original_item_id: 'gh-repo-10',
      original_issue_number: 10,
      project_id: 'my-project',
    };
    const result = parseMergeFixMeta(JSON.stringify(input));
    expect(result).not.toBeNull();
    expect(result!.merge_fix).toBe(true);
    expect(result!.pr_number).toBe(42);
    expect(result!.pr_url).toBe('https://github.com/owner/repo/pull/42');
    expect(result!.branch).toBe('fix/issue-10');
    expect(result!.main_branch).toBe('main');
    expect(result!.original_item_id).toBe('gh-repo-10');
    expect(result!.original_issue_number).toBe(10);
    expect(result!.project_id).toBe('my-project');
  });

  test('handles missing optional fields', () => {
    const meta = JSON.stringify({
      merge_fix: true,
      pr_number: 5,
      pr_url: 'https://example.com/pull/5',
      branch: 'fix/issue-3',
      main_branch: 'main',
      original_item_id: 'item-1',
      project_id: 'proj-a',
    });
    const result = parseMergeFixMeta(meta);
    expect(result).not.toBeNull();
    expect(result!.original_issue_number).toBeUndefined();
  });
});

describe('createMergeFixWorkItem', () => {
  test('creates a P1 work item with correct ID and title', () => {
    registerProject(ctx.bb.db, { id: 'proj-a', name: 'Project A', path: '/tmp/proj-a' });

    const itemId = createMergeFixWorkItem(ctx.bb, {
      originalItemId: 'gh-repo-10',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      branch: 'fix/issue-10',
      mainBranch: 'main',
      issueNumber: 10,
      projectId: 'proj-a',
      originalTitle: 'Fix the bug',
      sessionId: 'session-1',
    });

    expect(itemId).toBe('merge-fix-gh-repo-10-42');

    const items = ctx.bb.listWorkItems({ status: 'available' });
    const mergeFixItem = items.find((i) => i.item_id === itemId);
    expect(mergeFixItem).toBeDefined();
    expect(mergeFixItem!.title).toBe('Fix merge conflict: PR #42 for #10');
    expect(mergeFixItem!.priority).toBe('P1');
    expect(mergeFixItem!.source).toBe('merge-fix');
    expect(mergeFixItem!.project_id).toBe('proj-a');

    // Verify metadata
    const meta = JSON.parse(mergeFixItem!.metadata!);
    expect(meta.merge_fix).toBe(true);
    expect(meta.pr_number).toBe(42);
    expect(meta.branch).toBe('fix/issue-10');
    expect(meta.main_branch).toBe('main');
    expect(meta.original_item_id).toBe('gh-repo-10');
  });

  test('creates title without issue number when not provided', () => {
    registerProject(ctx.bb.db, { id: 'proj-a', name: 'Project A', path: '/tmp/proj-a' });

    const itemId = createMergeFixWorkItem(ctx.bb, {
      originalItemId: 'item-1',
      prNumber: 5,
      prUrl: 'https://example.com/pull/5',
      branch: 'fix/task-1',
      mainBranch: 'main',
      projectId: 'proj-a',
      originalTitle: 'Some task',
    });

    const items = ctx.bb.listWorkItems({ status: 'available' });
    const mergeFixItem = items.find((i) => i.item_id === itemId);
    expect(mergeFixItem!.title).toBe('Fix merge conflict: PR #5');
  });

  test('logs event linking merge-fix to original item', () => {
    registerProject(ctx.bb.db, { id: 'proj-a', name: 'Project A', path: '/tmp/proj-a' });

    createMergeFixWorkItem(ctx.bb, {
      originalItemId: 'gh-repo-10',
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      branch: 'fix/issue-10',
      mainBranch: 'main',
      issueNumber: 10,
      projectId: 'proj-a',
      originalTitle: 'Fix the bug',
      sessionId: 'session-1',
    });

    const events = ctx.bb.eventQueries.getRecent(10);
    const createEvent = events.find((e) => e.summary.includes('Created merge-fix work item'));
    expect(createEvent).toBeDefined();
    expect(createEvent!.summary).toContain('merge-fix-gh-repo-10-42');
    expect(createEvent!.summary).toContain('PR #42');
  });

  test('description includes PR URL and branch info', () => {
    registerProject(ctx.bb.db, { id: 'proj-a', name: 'Project A', path: '/tmp/proj-a' });

    const itemId = createMergeFixWorkItem(ctx.bb, {
      originalItemId: 'item-1',
      prNumber: 7,
      prUrl: 'https://github.com/owner/repo/pull/7',
      branch: 'fix/issue-5',
      mainBranch: 'main',
      issueNumber: 5,
      projectId: 'proj-a',
      originalTitle: 'Add feature X',
    });

    const items = ctx.bb.listWorkItems({ status: 'available' });
    const mergeFixItem = items.find((i) => i.item_id === itemId);
    expect(mergeFixItem!.description).toContain('https://github.com/owner/repo/pull/7');
    expect(mergeFixItem!.description).toContain('fix/issue-5');
    expect(mergeFixItem!.description).toContain('main');
    expect(mergeFixItem!.description).toContain('Add feature X');
  });
});
