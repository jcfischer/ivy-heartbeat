import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, cleanupTestContext, type TestContext } from './helpers.ts';
import { dispatch } from '../src/scheduler/scheduler.ts';
import { setLauncher, resetLauncher } from '../src/scheduler/launcher.ts';
import { registerProject } from 'ivy-blackboard/src/project';
import { createWorkItem } from 'ivy-blackboard/src/work';
import type { LaunchOptions, LaunchResult, DispatchOptions } from '../src/scheduler/types.ts';

let ctx: TestContext;
let launchCalls: LaunchOptions[];

function mockLauncher(exitCode = 0): (opts: LaunchOptions) => Promise<LaunchResult> {
  return async (opts) => {
    launchCalls.push(opts);
    return { exitCode, stdout: 'done', stderr: '' };
  };
}

function defaultOpts(overrides: Partial<DispatchOptions> = {}): DispatchOptions {
  return {
    maxConcurrent: 3,
    maxItems: 5,
    dryRun: false,
    timeout: 60,
    ...overrides,
  };
}

function seedProject(id: string, path: string): void {
  registerProject(ctx.bb.db, { id, name: id, path });
}

function seedWorkItem(id: string, project: string, priority = 'P2'): void {
  createWorkItem(ctx.bb.db, { id, title: `Task ${id}`, project, priority });
}

beforeEach(() => {
  ctx = createTestContext();
  launchCalls = [];
  setLauncher(mockLauncher(0));
});

afterEach(() => {
  resetLauncher();
  cleanupTestContext(ctx);
});

describe('dispatch', () => {
  test('returns empty result when no work items exist', async () => {
    const result = await dispatch(ctx.bb, defaultOpts());

    expect(result.dispatched).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.dryRun).toBe(false);
    expect(launchCalls).toHaveLength(0);
  });

  test('dispatches highest-priority available item', async () => {
    seedProject('proj-a', '/tmp/proj-a');
    seedWorkItem('low-pri', 'proj-a', 'P3');
    seedWorkItem('high-pri', 'proj-a', 'P1');

    const result = await dispatch(ctx.bb, defaultOpts({ maxItems: 1 }));

    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0].itemId).toBe('high-pri');
    expect(result.dispatched[0].completed).toBe(true);
    expect(result.dispatched[0].exitCode).toBe(0);
    expect(result.dispatched[0].projectId).toBe('proj-a');
    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0].workDir).toBe('/tmp/proj-a');
  });

  test('dispatches multiple items up to maxItems', async () => {
    seedProject('proj-a', '/tmp/proj-a');
    seedWorkItem('task-1', 'proj-a', 'P1');
    seedWorkItem('task-2', 'proj-a', 'P2');
    seedWorkItem('task-3', 'proj-a', 'P3');

    const result = await dispatch(ctx.bb, defaultOpts({ maxItems: 2 }));

    expect(result.dispatched).toHaveLength(2);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('exceeds max items per run');
    expect(launchCalls).toHaveLength(2);
  });

  test('respects project filter', async () => {
    seedProject('proj-a', '/tmp/proj-a');
    seedProject('proj-b', '/tmp/proj-b');
    seedWorkItem('task-a', 'proj-a', 'P1');
    seedWorkItem('task-b', 'proj-b', 'P1');

    const result = await dispatch(ctx.bb, defaultOpts({ project: 'proj-b' }));

    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0].itemId).toBe('task-b');
    expect(launchCalls[0].workDir).toBe('/tmp/proj-b');
  });

  test('respects priority filter', async () => {
    seedProject('proj-a', '/tmp/proj-a');
    seedWorkItem('task-p1', 'proj-a', 'P1');
    seedWorkItem('task-p2', 'proj-a', 'P2');
    seedWorkItem('task-p3', 'proj-a', 'P3');

    const result = await dispatch(ctx.bb, defaultOpts({ priority: 'P1' }));

    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0].itemId).toBe('task-p1');
  });

  test('skips items with no project assigned', async () => {
    // Create work item without a project
    createWorkItem(ctx.bb.db, { id: 'orphan', title: 'No project' });

    const result = await dispatch(ctx.bb, defaultOpts());

    expect(result.dispatched).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('no project assigned');
  });

  test('skips items whose project has no local_path', async () => {
    // Register project without a path
    registerProject(ctx.bb.db, { id: 'remote-only', name: 'Remote Only' });
    seedWorkItem('task-remote', 'remote-only');

    const result = await dispatch(ctx.bb, defaultOpts());

    expect(result.dispatched).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('no local_path');
  });

  test('dry run does not claim or launch', async () => {
    seedProject('proj-a', '/tmp/proj-a');
    seedWorkItem('task-1', 'proj-a', 'P1');

    const result = await dispatch(ctx.bb, defaultOpts({ dryRun: true }));

    expect(result.dryRun).toBe(true);
    expect(result.dispatched).toHaveLength(1);
    expect(result.dispatched[0].sessionId).toBe('(dry-run)');
    expect(result.dispatched[0].completed).toBe(false);
    expect(launchCalls).toHaveLength(0);

    // Verify item is still available
    const items = ctx.bb.listWorkItems({ status: 'available' });
    expect(items).toHaveLength(1);
    expect(items[0].item_id).toBe('task-1');
  });

  test('releases work on non-zero exit code', async () => {
    setLauncher(mockLauncher(1));
    seedProject('proj-a', '/tmp/proj-a');
    seedWorkItem('task-fail', 'proj-a');

    const result = await dispatch(ctx.bb, defaultOpts());

    expect(result.dispatched).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toContain('exit');

    // Verify item is back to available
    const items = ctx.bb.listWorkItems({ status: 'available' });
    expect(items).toHaveLength(1);
    expect(items[0].item_id).toBe('task-fail');
  });

  test('releases work on launcher exception', async () => {
    setLauncher(async () => {
      throw new Error('spawn failed');
    });
    seedProject('proj-a', '/tmp/proj-a');
    seedWorkItem('task-crash', 'proj-a');

    const result = await dispatch(ctx.bb, defaultOpts());

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].error).toBe('spawn failed');

    // Verify item is back to available
    const items = ctx.bb.listWorkItems({ status: 'available' });
    expect(items).toHaveLength(1);
  });

  test('respects concurrency limit from pre-existing agents', async () => {
    seedProject('proj-a', '/tmp/proj-a');
    seedWorkItem('task-1', 'proj-a');

    // Pre-register 3 agents to fill concurrency slots
    ctx.bb.registerAgent({ name: 'existing-1' });
    ctx.bb.registerAgent({ name: 'existing-2' });
    ctx.bb.registerAgent({ name: 'existing-3' });

    const result = await dispatch(ctx.bb, defaultOpts({ maxConcurrent: 3 }));

    expect(result.dispatched).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toContain('concurrency limit');
    expect(launchCalls).toHaveLength(0);
  });

  test('sequential processing allows multiple items with maxConcurrent=1', async () => {
    seedProject('proj-a', '/tmp/proj-a');
    seedWorkItem('task-1', 'proj-a', 'P1');
    seedWorkItem('task-2', 'proj-a', 'P2');

    // No pre-existing agents, maxConcurrent=1 allows sequential processing
    const result = await dispatch(ctx.bb, defaultOpts({ maxConcurrent: 1, maxItems: 2 }));

    expect(result.dispatched).toHaveLength(2);
    expect(launchCalls).toHaveLength(2);
  });

  test('prompt includes work item title and description', async () => {
    seedProject('proj-a', '/tmp/proj-a');
    createWorkItem(ctx.bb.db, {
      id: 'task-desc',
      title: 'Add retry logic',
      description: 'Implement exponential backoff for RSS fetcher',
      project: 'proj-a',
    });

    await dispatch(ctx.bb, defaultOpts());

    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0].prompt).toContain('Add retry logic');
    expect(launchCalls[0].prompt).toContain('exponential backoff');
  });

  test('timeout is passed to launcher in milliseconds', async () => {
    seedProject('proj-a', '/tmp/proj-a');
    seedWorkItem('task-1', 'proj-a');

    await dispatch(ctx.bb, defaultOpts({ timeout: 30 }));

    expect(launchCalls).toHaveLength(1);
    expect(launchCalls[0].timeoutMs).toBe(30 * 60 * 1000);
  });

  test('records events for dispatch lifecycle', async () => {
    seedProject('proj-a', '/tmp/proj-a');
    seedWorkItem('task-1', 'proj-a');

    await dispatch(ctx.bb, defaultOpts());

    const events = ctx.bb.eventQueries.getRecent(20);
    const summaries = events.map((e) => e.summary);

    // Should have: work_created, dispatch start, work_claimed, completion, work_completed, agent events
    expect(summaries.some((s) => s.includes('Dispatching'))).toBe(true);
    expect(summaries.some((s) => s.includes('Completed'))).toBe(true);
  });

  test('handles multiple projects in one run', async () => {
    seedProject('proj-a', '/tmp/proj-a');
    seedProject('proj-b', '/tmp/proj-b');
    seedWorkItem('task-a', 'proj-a', 'P1');
    seedWorkItem('task-b', 'proj-b', 'P2');

    const result = await dispatch(ctx.bb, defaultOpts({ maxItems: 2 }));

    expect(result.dispatched).toHaveLength(2);
    expect(launchCalls).toHaveLength(2);
    // P1 first, then P2
    expect(launchCalls[0].workDir).toBe('/tmp/proj-a');
    expect(launchCalls[1].workDir).toBe('/tmp/proj-b');
  });

  test('completed work items are not re-dispatched', async () => {
    seedProject('proj-a', '/tmp/proj-a');
    seedWorkItem('task-1', 'proj-a');

    // First dispatch completes it
    const r1 = await dispatch(ctx.bb, defaultOpts());
    expect(r1.dispatched).toHaveLength(1);
    expect(r1.dispatched[0].completed).toBe(true);

    // Second dispatch finds nothing
    const r2 = await dispatch(ctx.bb, defaultOpts());
    expect(r2.dispatched).toHaveLength(0);
    expect(r2.skipped).toHaveLength(0);
  });
});
