import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createTestContext, cleanupTestContext, type TestContext } from './helpers.ts';
import { registerProject } from 'ivy-blackboard/src/project';
import {
  runSpecFlowPhase,
  setSpecFlowSpawner,
  resetSpecFlowSpawner,
  setWorktreeOps,
  resetWorktreeOps,
  type SpecFlowSpawner,
} from '../src/scheduler/specflow-runner.ts';
import type { SpecFlowWorkItemMetadata } from '../src/scheduler/specflow-types.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';

// ─── Helpers ──────────────────────────────────────────────────────────

let ctx: TestContext;
let spawnerCalls: Array<{ args: string[]; cwd: string }>;

function mockSpawner(
  responses: Record<string, { exitCode: number; stdout: string; stderr: string }>
): SpecFlowSpawner {
  return async (args, cwd, _timeoutMs) => {
    spawnerCalls.push({ args, cwd });
    const key = args[0]; // phase name, 'eval', or 'init'
    // Always succeed for init unless explicitly overridden
    if (key === 'init' && !responses[key]) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    return responses[key] ?? { exitCode: 0, stdout: '', stderr: '' };
  };
}

function seedProject(id: string, path: string): void {
  registerProject(ctx.bb.db, { id, name: id, path });
}

function makeWorkItem(
  meta: SpecFlowWorkItemMetadata,
  overrides: Partial<BlackboardWorkItem> = {}
): BlackboardWorkItem {
  const itemId = `specflow-${meta.specflow_feature_id}-${meta.specflow_phase}`;
  return {
    item_id: itemId,
    title: `SpecFlow ${meta.specflow_phase}: ${meta.specflow_feature_id}`,
    description: null,
    project_id: meta.specflow_project_id,
    source: 'specflow',
    source_ref: meta.specflow_feature_id,
    priority: 'P2',
    status: 'claimed',
    claimed_by: 'test-session',
    metadata: JSON.stringify(meta),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMeta(overrides: Partial<SpecFlowWorkItemMetadata> = {}): SpecFlowWorkItemMetadata {
  return {
    specflow_feature_id: 'F-001',
    specflow_phase: 'specify',
    specflow_project_id: 'test-proj',
    ...overrides,
  };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  ctx = createTestContext();
  spawnerCalls = [];
  seedProject('test-proj', '/tmp/test-project');

  // Create mock worktree with features.db so init is skipped
  mkdirSync('/tmp/mock-worktree/.specflow', { recursive: true });
  writeFileSync('/tmp/mock-worktree/.specflow/features.db', '');

  // Mock worktree ops so tests don't call real git
  setWorktreeOps({
    createWorktree: async (_proj, _branch, _id) => '/tmp/mock-worktree',
    ensureWorktree: async (_proj, worktreePath, _branch) => {
      mkdirSync(`${worktreePath}/.specflow`, { recursive: true });
      writeFileSync(`${worktreePath}/.specflow/features.db`, '');
      return worktreePath;
    },
    removeWorktree: async () => {},
    commitAll: async () => null,
    pushBranch: async () => {},
    createPR: async () => ({ number: 1, url: 'https://github.com/test/repo/pull/1' }),
    getCurrentBranch: async () => 'main',
  });
});

afterEach(() => {
  resetSpecFlowSpawner();
  resetWorktreeOps();
  cleanupTestContext(ctx);
  for (const p of ['/tmp/mock-worktree', '/tmp/worktree', '/tmp/my-worktree']) {
    try { rmSync(p, { recursive: true }); } catch { /* best effort */ }
  }
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('specflow-runner', () => {
  describe('specify phase', () => {
    test('calls specflow specify --batch and chains plan on success', async () => {
      const meta = makeMeta({ specflow_phase: 'specify' });
      const item = makeWorkItem(meta);

      // Mock: specify succeeds, eval passes
      setSpecFlowSpawner(mockSpawner({
        specify: { exitCode: 0, stdout: '', stderr: '' },
        eval: { exitCode: 0, stdout: JSON.stringify({ score: 95, feedback: 'Good' }), stderr: '' },
      }));

      // Register agent so runSpecFlowPhase can log events
      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // Should have called specflow specify --batch (after init)
      const specifyCall = spawnerCalls.find((c) => c.args[0] === 'specify');
      expect(specifyCall).toBeDefined();
      expect(specifyCall!.args).toEqual(['specify', 'F-001', '--batch']);

      // Should have called eval
      const evalCall = spawnerCalls.find((c) => c.args[0] === 'eval');
      expect(evalCall).toBeDefined();

      // Should have created a plan work item
      const items = ctx.bb.listWorkItems({ all: true });
      const planItem = items.find((i) => {
        const m = JSON.parse(i.metadata ?? '{}');
        return m.specflow_phase === 'plan';
      });
      expect(planItem).toBeDefined();
      expect(planItem!.source).toBe('specflow');
    });
  });

  describe('plan phase', () => {
    test('reuses worktree from metadata and chains tasks', async () => {
      const meta = makeMeta({
        specflow_phase: 'plan',
        worktree_path: '/tmp/worktree/test-proj/specflow-f-001',
        main_branch: 'main',
      });
      const item = makeWorkItem(meta);

      setSpecFlowSpawner(mockSpawner({
        plan: { exitCode: 0, stdout: '', stderr: '' },
        eval: { exitCode: 0, stdout: JSON.stringify({ score: 90, feedback: 'OK' }), stderr: '' },
      }));

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // Should have called specflow plan (after init)
      const planCall = spawnerCalls.find((c) => c.args[0] === 'plan');
      expect(planCall).toBeDefined();
      expect(planCall!.args).toEqual(['plan', 'F-001']);

      // Should chain tasks phase
      const items = ctx.bb.listWorkItems({ all: true });
      const tasksItem = items.find((i) => {
        const m = JSON.parse(i.metadata ?? '{}');
        return m.specflow_phase === 'tasks';
      });
      expect(tasksItem).toBeDefined();
    });
  });

  describe('tasks phase', () => {
    test('chains implement phase (no quality gate)', async () => {
      const meta = makeMeta({
        specflow_phase: 'tasks',
        worktree_path: '/tmp/worktree/test-proj/specflow-f-001',
        main_branch: 'main',
      });
      const item = makeWorkItem(meta);

      setSpecFlowSpawner(mockSpawner({
        tasks: { exitCode: 0, stdout: '', stderr: '' },
      }));

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      const tasksCall = spawnerCalls.find((c) => c.args[0] === 'tasks');
      expect(tasksCall).toBeDefined();
      expect(tasksCall!.args).toEqual(['tasks', 'F-001']);

      // No eval call — tasks has no quality gate (only init + tasks)
      expect(spawnerCalls.filter((c) => c.args[0] !== 'init')).toHaveLength(1);

      // Should chain implement
      const items = ctx.bb.listWorkItems({ all: true });
      const implItem = items.find((i) => {
        const m = JSON.parse(i.metadata ?? '{}');
        return m.specflow_phase === 'implement';
      });
      expect(implItem).toBeDefined();
    });
  });

  describe('quality gate', () => {
    test('gate pass (score >= 80%) chains next phase', async () => {
      const meta = makeMeta({ specflow_phase: 'specify' });
      const item = makeWorkItem(meta);

      setSpecFlowSpawner(mockSpawner({
        specify: { exitCode: 0, stdout: '', stderr: '' },
        eval: { exitCode: 0, stdout: JSON.stringify({ score: 80 }), stderr: '' },
      }));

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // Should chain plan (gate passed at exactly 80%)
      const items = ctx.bb.listWorkItems({ all: true });
      const planItem = items.find((i) => {
        const m = JSON.parse(i.metadata ?? '{}');
        return m.specflow_phase === 'plan';
      });
      expect(planItem).toBeDefined();
    });

    test('gate fail (first attempt) creates retry with feedback', async () => {
      const meta = makeMeta({ specflow_phase: 'specify', retry_count: 0 });
      const item = makeWorkItem(meta);

      setSpecFlowSpawner(mockSpawner({
        specify: { exitCode: 0, stdout: '', stderr: '' },
        eval: {
          exitCode: 0,
          stdout: JSON.stringify({ score: 65, feedback: 'Missing edge cases' }),
          stderr: '',
        },
      }));

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // Should create retry item, not chain next
      const items = ctx.bb.listWorkItems({ all: true });
      const retryItem = items.find((i) => i.item_id.includes('retry'));
      expect(retryItem).toBeDefined();

      const retryMeta = JSON.parse(retryItem!.metadata ?? '{}');
      expect(retryMeta.specflow_phase).toBe('specify');
      expect(retryMeta.retry_count).toBe(1);
      expect(retryMeta.eval_feedback).toContain('Missing edge cases');

      // Should NOT create plan item
      const planItem = items.find((i) => {
        const m = JSON.parse(i.metadata ?? '{}');
        return m.specflow_phase === 'plan';
      });
      expect(planItem).toBeUndefined();
    });

    test('gate fail (max retries exceeded) does not create retry', async () => {
      const meta = makeMeta({ specflow_phase: 'specify', retry_count: 1 });
      const item = makeWorkItem(meta);

      setSpecFlowSpawner(mockSpawner({
        specify: { exitCode: 0, stdout: '', stderr: '' },
        eval: {
          exitCode: 0,
          stdout: JSON.stringify({ score: 50, feedback: 'Still bad' }),
          stderr: '',
        },
      }));

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // Should NOT create any new work items
      const items = ctx.bb.listWorkItems({ all: true });
      expect(items.filter((i) => i.item_id !== item.item_id)).toHaveLength(0);
    });
  });

  describe('work item chaining', () => {
    test('chained item inherits feature_id, worktree_path, priority', async () => {
      const meta = makeMeta({
        specflow_phase: 'tasks',
        worktree_path: '/tmp/my-worktree',
        main_branch: 'develop',
      });
      const item = makeWorkItem(meta, { priority: 'P1' });

      setSpecFlowSpawner(mockSpawner({
        tasks: { exitCode: 0, stdout: '', stderr: '' },
      }));

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      const items = ctx.bb.listWorkItems({ all: true });
      const implItem = items.find((i) => {
        const m = JSON.parse(i.metadata ?? '{}');
        return m.specflow_phase === 'implement';
      });

      expect(implItem).toBeDefined();
      expect(implItem!.priority).toBe('P1');

      const implMeta = JSON.parse(implItem!.metadata ?? '{}');
      expect(implMeta.specflow_feature_id).toBe('F-001');
      expect(implMeta.worktree_path).toBe('/tmp/my-worktree');
      expect(implMeta.main_branch).toBe('develop');
    });
  });

  describe('specflow CLI failure', () => {
    test('non-zero exit code does not chain next phase', async () => {
      const meta = makeMeta({ specflow_phase: 'specify' });
      const item = makeWorkItem(meta);

      setSpecFlowSpawner(mockSpawner({
        specify: { exitCode: 1, stdout: '', stderr: 'error' },
      }));

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // No chained items
      const items = ctx.bb.listWorkItems({ all: true });
      expect(items).toHaveLength(0);
    });

    test('timeout returns without chaining', async () => {
      const meta = makeMeta({ specflow_phase: 'specify' });
      const item = makeWorkItem(meta);

      setSpecFlowSpawner(async () => ({
        exitCode: -1,
        stdout: '',
        stderr: 'specflow timed out (SIGTERM)',
      }));

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // No chained items
      const items = ctx.bb.listWorkItems({ all: true });
      expect(items).toHaveLength(0);
    });
  });

  describe('complete phase', () => {
    test('runs specflow complete and attempts worktree cleanup', async () => {
      const meta = makeMeta({
        specflow_phase: 'complete',
        worktree_path: '/tmp/worktree/test-proj/specflow-f-001',
        main_branch: 'main',
      });
      const item = makeWorkItem(meta);

      setSpecFlowSpawner(mockSpawner({
        complete: { exitCode: 0, stdout: '', stderr: '' },
      }));

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      const completeCall = spawnerCalls.find((c) => c.args[0] === 'complete');
      expect(completeCall).toBeDefined();
      expect(completeCall!.args).toEqual(['complete', 'F-001']);

      // No chained items — pipeline is done
      const items = ctx.bb.listWorkItems({ all: true });
      expect(items).toHaveLength(0);
    });
  });
});
