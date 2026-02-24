import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, cleanupTestContext, type TestContext } from './helpers.ts';
import {
  parsePRMergeMeta,
  createPRMergeWorkItem,
  type PRMergeMetadata,
} from '../src/scheduler/pr-merge.ts';
import { registerProject } from 'ivy-blackboard/src/project';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  cleanupTestContext(ctx);
});

describe('parsePRMergeMeta', () => {
  test('returns null for null metadata', () => {
    expect(parsePRMergeMeta(null)).toBeNull();
  });

  test('returns null for non-merge metadata', () => {
    const meta = JSON.stringify({ github_issue_number: 1, github_repo: 'owner/repo' });
    expect(parsePRMergeMeta(meta)).toBeNull();
  });

  test('returns null for invalid JSON', () => {
    expect(parsePRMergeMeta('not json')).toBeNull();
  });

  test('returns null when pr_merge is not true', () => {
    const meta = JSON.stringify({ pr_merge: false, pr_number: 1, repo: 'r', branch: 'b' });
    expect(parsePRMergeMeta(meta)).toBeNull();
  });

  test('returns null when required fields are missing', () => {
    const meta = JSON.stringify({ pr_merge: true, pr_number: 1 });
    expect(parsePRMergeMeta(meta)).toBeNull();
  });

  test('parses valid PR merge metadata', () => {
    const input: PRMergeMetadata = {
      pr_merge: true,
      pr_number: 42,
      pr_url: 'https://github.com/owner/repo/pull/42',
      repo: 'owner/repo',
      branch: 'fix/issue-10',
      main_branch: 'main',
      implementation_work_item_id: 'gh-repo-10',
      project_id: 'my-project',
    };
    const result = parsePRMergeMeta(JSON.stringify(input));
    expect(result).not.toBeNull();
    expect(result!.pr_merge).toBe(true);
    expect(result!.pr_number).toBe(42);
    expect(result!.pr_url).toBe('https://github.com/owner/repo/pull/42');
    expect(result!.repo).toBe('owner/repo');
    expect(result!.branch).toBe('fix/issue-10');
    expect(result!.main_branch).toBe('main');
    expect(result!.implementation_work_item_id).toBe('gh-repo-10');
    expect(result!.project_id).toBe('my-project');
  });

  test('defaults main_branch to main when missing', () => {
    const meta = JSON.stringify({
      pr_merge: true,
      pr_number: 5,
      repo: 'owner/repo',
      branch: 'fix/task',
    });
    const result = parsePRMergeMeta(meta);
    expect(result).not.toBeNull();
    expect(result!.main_branch).toBe('main');
  });

  test('defaults optional fields to empty strings', () => {
    const meta = JSON.stringify({
      pr_merge: true,
      pr_number: 5,
      repo: 'owner/repo',
      branch: 'fix/task',
    });
    const result = parsePRMergeMeta(meta);
    expect(result!.pr_url).toBe('');
    expect(result!.implementation_work_item_id).toBe('');
    expect(result!.project_id).toBe('');
  });
});

describe('createPRMergeWorkItem', () => {
  test('creates a P1 work item with correct ID and title', () => {
    registerProject(ctx.bb.db, { id: 'proj-a', name: 'Project A', path: '/tmp/proj-a' });

    const itemId = createPRMergeWorkItem(ctx.bb, {
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      repo: 'owner/repo',
      branch: 'fix/issue-10',
      mainBranch: 'main',
      implementationWorkItemId: 'gh-repo-10',
      projectId: 'proj-a',
      originalTitle: 'Fix the bug',
      sessionId: 'session-1',
    });

    expect(itemId).toBe('merge-proj-a-pr-42');

    const items = ctx.bb.listWorkItems({ status: 'available' });
    const mergeItem = items.find((i) => i.item_id === itemId);
    expect(mergeItem).toBeDefined();
    expect(mergeItem!.title).toBe('Merge approved PR #42 - Fix the bug');
    expect(mergeItem!.priority).toBe('P1');
    expect(mergeItem!.source).toBe('pr_merge');
    expect(mergeItem!.project_id).toBe('proj-a');
  });

  test('metadata contains all required fields', () => {
    registerProject(ctx.bb.db, { id: 'proj-a', name: 'Project A', path: '/tmp/proj-a' });

    const itemId = createPRMergeWorkItem(ctx.bb, {
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      repo: 'owner/repo',
      branch: 'fix/issue-10',
      mainBranch: 'main',
      implementationWorkItemId: 'gh-repo-10',
      projectId: 'proj-a',
      originalTitle: 'Fix the bug',
    });

    const items = ctx.bb.listWorkItems({ status: 'available' });
    const mergeItem = items.find((i) => i.item_id === itemId);
    const meta = JSON.parse(mergeItem!.metadata!);
    expect(meta.pr_merge).toBe(true);
    expect(meta.pr_number).toBe(42);
    expect(meta.repo).toBe('owner/repo');
    expect(meta.branch).toBe('fix/issue-10');
    expect(meta.main_branch).toBe('main');
    expect(meta.implementation_work_item_id).toBe('gh-repo-10');
    expect(meta.project_id).toBe('proj-a');
  });

  test('logs event linking merge to implementation item', () => {
    registerProject(ctx.bb.db, { id: 'proj-a', name: 'Project A', path: '/tmp/proj-a' });

    createPRMergeWorkItem(ctx.bb, {
      prNumber: 42,
      prUrl: 'https://github.com/owner/repo/pull/42',
      repo: 'owner/repo',
      branch: 'fix/issue-10',
      mainBranch: 'main',
      implementationWorkItemId: 'gh-repo-10',
      projectId: 'proj-a',
      originalTitle: 'Fix the bug',
      sessionId: 'session-1',
    });

    const events = ctx.bb.eventQueries.getRecent(10);
    const createEvent = events.find((e) => e.summary.includes('Created merge work item'));
    expect(createEvent).toBeDefined();
    expect(createEvent!.summary).toContain('merge-proj-a-pr-42');
    expect(createEvent!.summary).toContain('PR #42');
    expect(createEvent!.target_id).toBe('gh-repo-10');
  });

  test('description includes PR URL and branch info', () => {
    registerProject(ctx.bb.db, { id: 'proj-a', name: 'Project A', path: '/tmp/proj-a' });

    const itemId = createPRMergeWorkItem(ctx.bb, {
      prNumber: 7,
      prUrl: 'https://github.com/owner/repo/pull/7',
      repo: 'owner/repo',
      branch: 'fix/issue-5',
      mainBranch: 'main',
      implementationWorkItemId: 'item-1',
      projectId: 'proj-a',
      originalTitle: 'Add feature X',
    });

    const items = ctx.bb.listWorkItems({ status: 'available' });
    const mergeItem = items.find((i) => i.item_id === itemId);
    expect(mergeItem!.description).toContain('https://github.com/owner/repo/pull/7');
    expect(mergeItem!.description).toContain('fix/issue-5');
    expect(mergeItem!.description).toContain('main');
  });

  test('sourceRef is set to PR URL', () => {
    registerProject(ctx.bb.db, { id: 'proj-a', name: 'Project A', path: '/tmp/proj-a' });

    const itemId = createPRMergeWorkItem(ctx.bb, {
      prNumber: 7,
      prUrl: 'https://github.com/owner/repo/pull/7',
      repo: 'owner/repo',
      branch: 'fix/issue-5',
      mainBranch: 'main',
      implementationWorkItemId: 'item-1',
      projectId: 'proj-a',
      originalTitle: 'Task',
    });

    const items = ctx.bb.listWorkItems({ status: 'available' });
    const mergeItem = items.find((i) => i.item_id === itemId);
    expect(mergeItem!.source_ref).toBe('https://github.com/owner/repo/pull/7');
  });
});
