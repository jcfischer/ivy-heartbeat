import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, cleanupTestContext, type TestContext } from './helpers.ts';
import { registerProject } from 'ivy-blackboard/src/project';
import {
  evaluateSpecFlowCleanup,
  setCleanupBlackboard,
  resetCleanupBlackboard,
  setWorktreeScanner,
  resetWorktreeScanner,
  setWorktreeRemover,
  resetWorktreeRemover,
  type CleanupBlackboardAccessor,
} from '../src/evaluators/specflow-cleanup.ts';
import type { ChecklistItem } from '../src/parser/types.ts';

// ─── Helpers ──────────────────────────────────────────────────────────

let ctx: TestContext;
let removedPaths: string[];

function makeItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    name: 'SpecFlow Cleanup',
    type: 'specflow_cleanup',
    severity: 'medium',
    channels: ['terminal'],
    enabled: true,
    description: 'Clean stale specflow worktrees',
    config: { staleness_days: 7 },
    ...overrides,
  };
}

function makeBbAccessor(
  items: Array<{ metadata: string | null; updated_at?: string }>
): CleanupBlackboardAccessor {
  const events: Array<{ summary: string; metadata?: Record<string, unknown> }> = [];
  return {
    listWorkItems: () => items,
    appendEvent: (opts) => events.push(opts),
  };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  ctx = createTestContext();
  removedPaths = [];
  setWorktreeRemover(async (_projectPath, worktreePath) => {
    removedPaths.push(worktreePath);
  });
});

afterEach(() => {
  resetCleanupBlackboard();
  resetWorktreeScanner();
  resetWorktreeRemover();
  cleanupTestContext(ctx);
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('specflow-cleanup evaluator', () => {
  test('no worktrees returns ok', async () => {
    setWorktreeScanner(() => []);
    setCleanupBlackboard(makeBbAccessor([]));

    const result = await evaluateSpecFlowCleanup(makeItem());

    expect(result.status).toBe('ok');
    expect(result.summary).toContain('no specflow worktrees found');
  });

  test('stale worktree is removed', async () => {
    const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago

    setWorktreeScanner(() => [
      { path: '/tmp/worktree/proj/specflow-f-001', projectPath: '/tmp/worktree/proj', featureId: 'F-001' },
    ]);

    setCleanupBlackboard(makeBbAccessor([
      {
        metadata: JSON.stringify({ specflow_feature_id: 'F-001', specflow_phase: 'specify' }),
        updated_at: staleDate,
      },
    ]));

    const result = await evaluateSpecFlowCleanup(makeItem());

    expect(result.status).toBe('ok');
    expect(removedPaths).toEqual(['/tmp/worktree/proj/specflow-f-001']);
    expect(result.details).toEqual({ cleaned: 1, total: 1 });
  });

  test('active worktree with recent work items is preserved', async () => {
    const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

    setWorktreeScanner(() => [
      { path: '/tmp/worktree/proj/specflow-f-002', projectPath: '/tmp/worktree/proj', featureId: 'F-002' },
    ]);

    setCleanupBlackboard(makeBbAccessor([
      {
        metadata: JSON.stringify({ specflow_feature_id: 'F-002', specflow_phase: 'plan' }),
        updated_at: recentDate,
      },
    ]));

    const result = await evaluateSpecFlowCleanup(makeItem());

    expect(result.status).toBe('ok');
    expect(removedPaths).toHaveLength(0);
    expect(result.details).toEqual({ cleaned: 0, total: 1 });
  });

  test('cleanup failure returns alert', async () => {
    const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

    setWorktreeScanner(() => [
      { path: '/tmp/worktree/proj/specflow-f-003', projectPath: '/tmp/worktree/proj', featureId: 'F-003' },
    ]);

    setWorktreeRemover(async () => {
      throw new Error('permission denied');
    });

    setCleanupBlackboard(makeBbAccessor([
      {
        metadata: JSON.stringify({ specflow_feature_id: 'F-003', specflow_phase: 'specify' }),
        updated_at: staleDate,
      },
    ]));

    const result = await evaluateSpecFlowCleanup(makeItem());

    expect(result.status).toBe('alert');
    expect(result.summary).toContain('failure');
  });

  test('blackboard not configured returns error', async () => {
    resetCleanupBlackboard();

    const result = await evaluateSpecFlowCleanup(makeItem());

    expect(result.status).toBe('error');
    expect(result.summary).toContain('blackboard not configured');
  });

  test('no work items for feature makes worktree stale', async () => {
    setWorktreeScanner(() => [
      { path: '/tmp/worktree/proj/specflow-f-004', projectPath: '/tmp/worktree/proj', featureId: 'F-004' },
    ]);

    // No matching work items for this feature
    setCleanupBlackboard(makeBbAccessor([
      {
        metadata: JSON.stringify({ specflow_feature_id: 'F-OTHER', specflow_phase: 'specify' }),
        updated_at: new Date().toISOString(),
      },
    ]));

    const result = await evaluateSpecFlowCleanup(makeItem());

    expect(result.status).toBe('ok');
    expect(removedPaths).toEqual(['/tmp/worktree/proj/specflow-f-004']);
  });

  test('configurable staleness_days', async () => {
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    setWorktreeScanner(() => [
      { path: '/tmp/worktree/proj/specflow-f-005', projectPath: '/tmp/worktree/proj', featureId: 'F-005' },
    ]);

    setCleanupBlackboard(makeBbAccessor([
      {
        metadata: JSON.stringify({ specflow_feature_id: 'F-005', specflow_phase: 'plan' }),
        updated_at: threeDaysAgo,
      },
    ]));

    // With default 7 days: not stale
    const result7 = await evaluateSpecFlowCleanup(makeItem({ config: { staleness_days: 7 } }));
    expect(removedPaths).toHaveLength(0);

    // With 2 days: stale
    removedPaths = [];
    const result2 = await evaluateSpecFlowCleanup(makeItem({ config: { staleness_days: 2 } }));
    expect(removedPaths).toEqual(['/tmp/worktree/proj/specflow-f-005']);
  });
});
