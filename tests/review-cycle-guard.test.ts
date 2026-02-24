import { test, expect, describe, beforeEach, afterEach, mock } from 'bun:test';
import {
  hasActiveReviewCycle,
  setReviewCycleAccessor,
  resetReviewCycleAccessor,
  type ReviewCycleAccessor,
} from '../src/scheduler/worktree.ts';

function createMockAccessor(items: Array<{
  item_id: string;
  source: string | null;
  metadata: string | null;
  status: string;
}>): ReviewCycleAccessor {
  return {
    listWorkItems: mock((opts?: { status?: string }) => {
      return items.filter(i => !opts?.status || i.status === opts.status);
    }),
  };
}

describe('hasActiveReviewCycle', () => {
  afterEach(() => {
    resetReviewCycleAccessor();
  });

  test('returns false when no accessor is set', () => {
    expect(hasActiveReviewCycle('fix/issue-25')).toBe(false);
  });

  test('returns false when no work items exist', () => {
    setReviewCycleAccessor(createMockAccessor([]));
    expect(hasActiveReviewCycle('fix/issue-25')).toBe(false);
  });

  test('returns true when pending code_review item references the branch', () => {
    setReviewCycleAccessor(createMockAccessor([{
      item_id: 'review-1',
      source: 'code_review',
      metadata: JSON.stringify({ branch: 'fix/issue-25', pr_number: 10, review_status: null }),
      status: 'pending',
    }]));
    expect(hasActiveReviewCycle('fix/issue-25')).toBe(true);
  });

  test('returns true when claimed rework item references the branch', () => {
    setReviewCycleAccessor(createMockAccessor([{
      item_id: 'rework-1',
      source: 'rework',
      metadata: JSON.stringify({ rework: true, branch: 'fix/issue-25', pr_number: 10 }),
      status: 'claimed',
    }]));
    expect(hasActiveReviewCycle('fix/issue-25')).toBe(true);
  });

  test('returns true when pending pr_merge item references the branch', () => {
    setReviewCycleAccessor(createMockAccessor([{
      item_id: 'merge-1',
      source: 'pr_merge',
      metadata: JSON.stringify({ pr_merge: true, branch: 'fix/issue-25', pr_number: 10 }),
      status: 'pending',
    }]));
    expect(hasActiveReviewCycle('fix/issue-25')).toBe(true);
  });

  test('returns true when pending merge-fix item references the branch', () => {
    setReviewCycleAccessor(createMockAccessor([{
      item_id: 'merge-fix-1',
      source: 'merge-fix',
      metadata: JSON.stringify({ merge_fix: true, branch: 'fix/issue-25', pr_number: 10 }),
      status: 'pending',
    }]));
    expect(hasActiveReviewCycle('fix/issue-25')).toBe(true);
  });

  test('returns false when items reference a different branch', () => {
    setReviewCycleAccessor(createMockAccessor([{
      item_id: 'review-1',
      source: 'code_review',
      metadata: JSON.stringify({ branch: 'fix/issue-99', pr_number: 10, review_status: null }),
      status: 'pending',
    }]));
    expect(hasActiveReviewCycle('fix/issue-25')).toBe(false);
  });

  test('returns false when review items are completed (not pending/claimed)', () => {
    setReviewCycleAccessor(createMockAccessor([{
      item_id: 'review-1',
      source: 'code_review',
      metadata: JSON.stringify({ branch: 'fix/issue-25', pr_number: 10, review_status: 'approved' }),
      status: 'completed',
    }]));
    expect(hasActiveReviewCycle('fix/issue-25')).toBe(false);
  });

  test('returns true when rework item has generic source but rework metadata', () => {
    setReviewCycleAccessor(createMockAccessor([{
      item_id: 'rework-1',
      source: 'github_issue',
      metadata: JSON.stringify({ rework: true, branch: 'fix/issue-25', pr_number: 10 }),
      status: 'pending',
    }]));
    expect(hasActiveReviewCycle('fix/issue-25')).toBe(true);
  });

  test('returns false when metadata is invalid JSON', () => {
    setReviewCycleAccessor(createMockAccessor([{
      item_id: 'bad-1',
      source: 'code_review',
      metadata: 'not-json',
      status: 'pending',
    }]));
    expect(hasActiveReviewCycle('fix/issue-25')).toBe(false);
  });

  test('returns false when metadata is null', () => {
    setReviewCycleAccessor(createMockAccessor([{
      item_id: 'null-1',
      source: 'code_review',
      metadata: null,
      status: 'pending',
    }]));
    expect(hasActiveReviewCycle('fix/issue-25')).toBe(false);
  });

  test('checks both pending and claimed statuses', () => {
    const accessor = createMockAccessor([{
      item_id: 'review-1',
      source: 'code_review',
      metadata: JSON.stringify({ branch: 'fix/issue-25', pr_number: 10, review_status: null }),
      status: 'claimed',
    }]);
    setReviewCycleAccessor(accessor);
    expect(hasActiveReviewCycle('fix/issue-25')).toBe(true);
    // Should have been called with 'pending' and then 'claimed'
    expect(accessor.listWorkItems).toHaveBeenCalled();
  });
});
