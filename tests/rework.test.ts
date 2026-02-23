import { test, expect, describe, mock, beforeEach } from 'bun:test';
import {
  parseReworkMeta,
  createReworkWorkItem,
  buildReworkPrompt,
  MAX_REWORK_CYCLES,
} from '../src/scheduler/rework.ts';

// Mock blackboard
function createMockBb() {
  const events: any[] = [];
  const items: any[] = [];
  return {
    createWorkItem: mock((opts: any) => { items.push(opts); }),
    appendEvent: mock((ev: any) => { events.push(ev); }),
    _events: events,
    _items: items,
  };
}

describe('parseReworkMeta', () => {
  test('returns null for null metadata', () => {
    expect(parseReworkMeta(null)).toBeNull();
  });

  test('returns null for non-rework metadata', () => {
    expect(parseReworkMeta(JSON.stringify({ merge_fix: true, pr_number: 1 }))).toBeNull();
  });

  test('returns null for invalid JSON', () => {
    expect(parseReworkMeta('not json')).toBeNull();
  });

  test('parses valid rework metadata', () => {
    const meta = {
      rework: true,
      pr_number: 42,
      pr_url: 'https://github.com/owner/repo/pull/42',
      repo: 'owner/repo',
      branch: 'fix/issue-10',
      implementation_work_item_id: 'gh-repo-10',
      review_feedback: 'Fix the SQL injection',
      rework_cycle: 2,
      project_id: 'my-project',
    };
    const result = parseReworkMeta(JSON.stringify(meta));
    expect(result).not.toBeNull();
    expect(result!.rework).toBe(true);
    expect(result!.pr_number).toBe(42);
    expect(result!.repo).toBe('owner/repo');
    expect(result!.rework_cycle).toBe(2);
    expect(result!.review_feedback).toBe('Fix the SQL injection');
  });

  test('defaults rework_cycle to 1 if missing', () => {
    const meta = {
      rework: true,
      pr_number: 5,
      repo: 'o/r',
      branch: 'fix/1',
    };
    const result = parseReworkMeta(JSON.stringify(meta));
    expect(result!.rework_cycle).toBe(1);
  });
});

describe('createReworkWorkItem', () => {
  test('creates a work item with correct ID format', () => {
    const bb = createMockBb();
    const id = createReworkWorkItem(bb as any, {
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
      repo: 'o/r',
      branch: 'fix/issue-10',
      implementationWorkItemId: 'gh-r-10',
      reviewFeedback: 'Fix SQL injection',
      reworkCycle: 1,
      projectId: 'my-proj',
      originalTitle: 'Fix auth bug',
      sessionId: 'sess-1',
    });
    expect(id).toBe('rework-my-proj-pr-42-cycle-1');
    expect(bb.createWorkItem).toHaveBeenCalledTimes(1);
    const call = bb._items[0];
    expect(call.id).toBe('rework-my-proj-pr-42-cycle-1');
    expect(call.source).toBe('rework');
    expect(call.priority).toBe('P1');
  });

  test('returns null when cycle exceeds MAX_REWORK_CYCLES', () => {
    const bb = createMockBb();
    const id = createReworkWorkItem(bb as any, {
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
      repo: 'o/r',
      branch: 'fix/issue-10',
      implementationWorkItemId: 'gh-r-10',
      reviewFeedback: 'Fix it',
      reworkCycle: MAX_REWORK_CYCLES + 1,
      projectId: 'my-proj',
      originalTitle: 'Fix auth bug',
      sessionId: 'sess-1',
    });
    expect(id).toBeNull();
    expect(bb.createWorkItem).not.toHaveBeenCalled();
    // Should still log an event about hitting the limit
    expect(bb.appendEvent).toHaveBeenCalledTimes(1);
    expect(bb._events[0].summary).toContain('cycle limit reached');
  });

  test('includes review feedback in description', () => {
    const bb = createMockBb();
    createReworkWorkItem(bb as any, {
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7',
      repo: 'o/r',
      branch: 'fix/5',
      implementationWorkItemId: 'gh-r-5',
      reviewFeedback: 'Missing input validation on line 42',
      reworkCycle: 1,
      projectId: 'proj',
      originalTitle: 'Add endpoint',
    });
    const call = bb._items[0];
    expect(call.description).toContain('Missing input validation on line 42');
    expect(call.description).toContain('PR #7');
    expect(call.description).toContain('fix/5');
  });

  test('cycle 3 is allowed, cycle 4 is blocked', () => {
    const bb = createMockBb();
    const opts = {
      prNumber: 1, prUrl: '', repo: 'o/r', branch: 'b',
      implementationWorkItemId: 'x', reviewFeedback: 'f',
      projectId: 'p', originalTitle: 't',
    };
    expect(createReworkWorkItem(bb as any, { ...opts, reworkCycle: 3 })).not.toBeNull();
    expect(createReworkWorkItem(bb as any, { ...opts, reworkCycle: 4 })).toBeNull();
  });
});

describe('buildReworkPrompt', () => {
  test('includes PR number and repo', () => {
    const prompt = buildReworkPrompt({
      rework: true,
      pr_number: 42,
      pr_url: 'https://github.com/o/r/pull/42',
      repo: 'owner/repo',
      branch: 'fix/10',
      implementation_work_item_id: 'x',
      review_feedback: 'Fix the bug on line 5',
      rework_cycle: 1,
      project_id: 'p',
    });
    expect(prompt).toContain('PR #42');
    expect(prompt).toContain('owner/repo');
    expect(prompt).toContain('Fix the bug on line 5');
    expect(prompt).toContain('cycle 1/3');
  });

  test('includes gh CLI commands for fetching review comments', () => {
    const prompt = buildReworkPrompt({
      rework: true,
      pr_number: 10,
      pr_url: '',
      repo: 'o/r',
      branch: 'b',
      implementation_work_item_id: 'x',
      review_feedback: 'feedback',
      rework_cycle: 2,
      project_id: 'p',
    });
    expect(prompt).toContain('gh pr view 10');
    expect(prompt).toContain('gh api repos/o/r/pulls/10/comments');
  });
});

describe('MAX_REWORK_CYCLES', () => {
  test('is set to 3', () => {
    expect(MAX_REWORK_CYCLES).toBe(3);
  });
});
