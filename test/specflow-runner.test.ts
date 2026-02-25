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
  detectMissingArtifacts,
  type SpecFlowSpawner,
} from '../src/scheduler/specflow-runner.ts';
import { setLauncher, resetLauncher } from '../src/scheduler/launcher.ts';
import type { SpecFlowWorkItemMetadata } from '../src/scheduler/specflow-types.ts';
import type { BlackboardWorkItem } from 'ivy-blackboard/src/types';

// ─── Helpers ──────────────────────────────────────────────────────────

let ctx: TestContext;
let spawnerCalls: Array<{ args: string[]; cwd: string }>;

/** Map phase names to their expected artifact filenames */
const PHASE_ARTIFACT_FILES: Record<string, string> = {
  specify: 'spec.md',
  plan: 'plan.md',
  tasks: 'tasks.md',
};

function mockSpawner(
  responses: Record<string, { exitCode: number; stdout: string; stderr: string }>
): SpecFlowSpawner {
  return async (args, cwd, _timeoutMs) => {
    spawnerCalls.push({ args, cwd });
    const key = args[0]; // phase name, 'eval', 'init', or 'phase'
    // Always succeed for init/phase unless explicitly overridden
    if ((key === 'init' || key === 'phase') && !responses[key]) {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    const response = responses[key] ?? { exitCode: 0, stdout: '', stderr: '' };

    // Prompt-output mode: when SPECFLOW_PROMPT_OUTPUT is set, specflow writes
    // the prompt to a file and exits instead of calling claude -p.
    // In tests, this simulates the specflow binary's prompt-output behavior.
    const promptOutputPath = process.env.SPECFLOW_PROMPT_OUTPUT;
    if (promptOutputPath && PHASE_ARTIFACT_FILES[key] && response.exitCode === 0) {
      writeFileSync(promptOutputPath, JSON.stringify({
        prompt: `Mock ${key} prompt for ${args[1] ?? 'unknown'}`,
        systemPrompt: `You are a ${key} agent.`,
      }));
      return response;
    }

    // Simulate artifact creation on success (mirrors real specflow CLI behavior)
    if (response.exitCode === 0 && PHASE_ARTIFACT_FILES[key]) {
      const featureId = args[1] ?? 'F-001';
      const specDir = `${cwd}/.specify/specs/${featureId}`;
      mkdirSync(specDir, { recursive: true });
      writeFileSync(`${specDir}/${PHASE_ARTIFACT_FILES[key]}`, `# ${key} artifact`);
    }
    return response;
  };
}

/** Mock launcher that creates the expected artifact file for a launcher-phase */
function mockLauncherForPhase(phase: string) {
  const artifactFile = PHASE_ARTIFACT_FILES[phase];
  setLauncher(async (opts) => {
    if (artifactFile) {
      const specDir = `${opts.workDir}/.specify/specs/F-001`;
      mkdirSync(specDir, { recursive: true });
      writeFileSync(`${specDir}/${artifactFile}`, `# ${phase} artifact`);
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  });
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
    isCleanBranch: async () => true,
    getDiffSummary: async () => '',
    getChangedFiles: async () => ['src/index.ts'],
  });
});

afterEach(() => {
  resetSpecFlowSpawner();
  resetWorktreeOps();
  resetLauncher();
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
        eval: { exitCode: 0, stdout: JSON.stringify({ results: [{ passed: true, score: 0.95, output: 'Good' }], passed: 1, failed: 0 }), stderr: '' },
      }));
      mockLauncherForPhase('specify');

      // Register agent so runSpecFlowPhase can log events
      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // Should have called specflow specify (no --batch; headless auto-enables batch when data available)
      const specifyCall = spawnerCalls.find((c) => c.args[0] === 'specify');
      expect(specifyCall).toBeDefined();
      expect(specifyCall!.args).toEqual(['specify', 'F-001']);

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
        eval: { exitCode: 0, stdout: JSON.stringify({ results: [{ passed: true, score: 0.90, output: 'OK' }], passed: 1, failed: 0 }), stderr: '' },
      }));
      mockLauncherForPhase('plan');

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
      mockLauncherForPhase('tasks');

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

      // No eval call — tasks has no quality gate (only init + status + tasks + phase)
      expect(spawnerCalls.filter((c) => !['init', 'status', 'phase'].includes(c.args[0]))).toHaveLength(1);

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
        eval: { exitCode: 0, stdout: JSON.stringify({ results: [{ passed: true, score: 0.80, output: 'Good' }], passed: 1, failed: 0 }), stderr: '' },
      }));
      mockLauncherForPhase('specify');

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
          stdout: JSON.stringify({ results: [{ passed: false, score: 0.65, output: 'Missing edge cases' }], passed: 0, failed: 1 }),
          stderr: '',
        },
      }));
      mockLauncherForPhase('specify');

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
          stdout: JSON.stringify({ results: [{ passed: false, score: 0.50, output: 'Still bad' }], passed: 0, failed: 1 }),
          stderr: '',
        },
      }));
      mockLauncherForPhase('specify');

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
      mockLauncherForPhase('tasks');

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
      // Launcher not needed — specify fails before prompt extraction, so launcher is never called

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

    test('generates missing artifacts and retries on complete failure', async () => {
      const meta = makeMeta({
        specflow_phase: 'complete',
        worktree_path: '/tmp/mock-worktree',
        main_branch: 'main',
      });
      const item = makeWorkItem(meta);

      // Create spec dir so findFeatureDir can find it
      const specDir = '/tmp/mock-worktree/.specify/specs/f-001-test-feature';
      mkdirSync(specDir, { recursive: true });

      // First complete call fails with missing artifacts, second succeeds
      let completeCallCount = 0;
      setSpecFlowSpawner(async (args, cwd, _timeout) => {
        spawnerCalls.push({ args, cwd });
        if (args[0] === 'complete') {
          completeCallCount++;
          if (completeCallCount === 1) {
            return { exitCode: 1, stdout: '', stderr: 'Error: missing required artifact: docs.md is missing, verify.md not found' };
          }
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      // Mock launcher: writes the artifact files
      let launcherCalls: string[] = [];
      setLauncher(async (opts) => {
        launcherCalls.push(opts.sessionId);
        // Simulate Claude creating the files
        if (opts.sessionId.includes('docs')) {
          writeFileSync(`${specDir}/docs.md`, '# Docs\nGenerated docs.');
        } else if (opts.sessionId.includes('verify')) {
          writeFileSync(`${specDir}/verify.md`, '# Verify\nAll tests pass.');
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      const result = await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      expect(result).toEqual({ status: 'completed' });
      // Launcher should have been called twice (docs.md + verify.md)
      expect(launcherCalls).toHaveLength(2);
      expect(launcherCalls[0]).toContain('docs');
      expect(launcherCalls[1]).toContain('verify');
      // specflow complete should have been called at least twice (fail + retry)
      expect(completeCallCount).toBeGreaterThanOrEqual(2);
    });

    test('returns false when artifact generation fails', async () => {
      const meta = makeMeta({
        specflow_phase: 'complete',
        worktree_path: '/tmp/mock-worktree',
        main_branch: 'main',
      });
      const item = makeWorkItem(meta);

      mkdirSync('/tmp/mock-worktree/.specify/specs/f-001-test-feature', { recursive: true });

      setSpecFlowSpawner(async (args, cwd, _timeout) => {
        spawnerCalls.push({ args, cwd });
        if (args[0] === 'complete') {
          return { exitCode: 1, stdout: '', stderr: 'docs.md is missing' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      // Mock launcher that fails
      setLauncher(async () => {
        return { exitCode: 1, stdout: '', stderr: 'Claude failed' };
      });

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      const result = await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // Complete failures still proceed to PR creation (handleCompletePhase)
      // — with no commits ahead, it skips PR and returns completed
      expect(result).toEqual({ status: 'completed', nextPhase: undefined });
    });

    test('returns false when retry fails after artifact generation', async () => {
      const meta = makeMeta({
        specflow_phase: 'complete',
        worktree_path: '/tmp/mock-worktree',
        main_branch: 'main',
      });
      const item = makeWorkItem(meta);

      const specDir = '/tmp/mock-worktree/.specify/specs/f-001-test-feature';
      mkdirSync(specDir, { recursive: true });

      // Complete always fails
      setSpecFlowSpawner(async (args, cwd, _timeout) => {
        spawnerCalls.push({ args, cwd });
        if (args[0] === 'complete') {
          return { exitCode: 1, stdout: '', stderr: 'verify.md is missing' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      // Launcher succeeds and creates the file
      setLauncher(async (opts) => {
        writeFileSync(`${specDir}/verify.md`, '# Verify');
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      const result = await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // Complete failures still proceed to PR creation — with no commits, returns completed
      expect(result).toEqual({ status: 'completed', nextPhase: undefined });
    });

    test('returns false when complete fails for non-artifact reason', async () => {
      const meta = makeMeta({
        specflow_phase: 'complete',
        worktree_path: '/tmp/mock-worktree',
        main_branch: 'main',
      });
      const item = makeWorkItem(meta);

      setSpecFlowSpawner(async (args, cwd, _timeout) => {
        spawnerCalls.push({ args, cwd });
        if (args[0] === 'complete') {
          return { exitCode: 1, stdout: '', stderr: 'database connection error' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      const result = await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // Complete failures still proceed to PR creation — with no commits, returns completed
      expect(result).toEqual({ status: 'completed', nextPhase: undefined });
    });
  });

  describe('implement phase — uncommitted change detection', () => {
    test('augments prompt with prior work context when worktree has uncommitted changes', async () => {
      const meta = makeMeta({
        specflow_phase: 'implement',
        worktree_path: '/tmp/mock-worktree',
        main_branch: 'main',
      });
      const item = makeWorkItem(meta);

      const implementPrompt = 'Implement feature F-001 following the plan in plan.md';

      // specflow implement returns the prompt on stdout
      setSpecFlowSpawner(mockSpawner({
        implement: { exitCode: 0, stdout: implementPrompt, stderr: '' },
      }));

      // Worktree has uncommitted changes from prior attempt
      setWorktreeOps({
        createWorktree: async (_proj, _branch, _id) => '/tmp/mock-worktree',
        ensureWorktree: async (_proj, worktreePath, _branch) => {
          mkdirSync(`${worktreePath}/.specflow`, { recursive: true });
          writeFileSync(`${worktreePath}/.specflow/features.db`, '');
          return worktreePath;
        },
        removeWorktree: async () => {},
        commitAll: async () => 'abc123',
        pushBranch: async () => {},
        createPR: async () => ({ number: 1, url: 'https://github.com/test/repo/pull/1' }),
        getCurrentBranch: async () => 'main',
        isCleanBranch: async () => false, // <-- uncommitted changes exist
        getDiffSummary: async () => ' src/foo.ts | 42 +++\n src/bar.ts | 15 +++\n 2 files changed, 57 insertions(+)',
      });

      // Capture what prompt the launcher receives
      let launcherPrompt = '';
      setLauncher(async (opts) => {
        launcherPrompt = opts.prompt;
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // Prompt should be augmented with prior work context
      expect(launcherPrompt).toContain('Prior Implementation Work Detected');
      expect(launcherPrompt).toContain('src/foo.ts');
      expect(launcherPrompt).toContain('Do NOT re-implement from scratch');
      // Original prompt should still be present
      expect(launcherPrompt).toContain(implementPrompt);
    });

    test('does not augment prompt when worktree is clean', async () => {
      const meta = makeMeta({
        specflow_phase: 'implement',
        worktree_path: '/tmp/mock-worktree',
        main_branch: 'main',
      });
      const item = makeWorkItem(meta);

      const implementPrompt = 'Implement feature F-001 following the plan in plan.md';

      setSpecFlowSpawner(mockSpawner({
        implement: { exitCode: 0, stdout: implementPrompt, stderr: '' },
      }));

      // Worktree is clean — no prior changes
      setWorktreeOps({
        createWorktree: async (_proj, _branch, _id) => '/tmp/mock-worktree',
        ensureWorktree: async (_proj, worktreePath, _branch) => {
          mkdirSync(`${worktreePath}/.specflow`, { recursive: true });
          writeFileSync(`${worktreePath}/.specflow/features.db`, '');
          return worktreePath;
        },
        removeWorktree: async () => {},
        commitAll: async () => 'abc123',
        pushBranch: async () => {},
        createPR: async () => ({ number: 1, url: 'https://github.com/test/repo/pull/1' }),
        getCurrentBranch: async () => 'main',
        isCleanBranch: async () => true, // <-- clean
        getDiffSummary: async () => '',
      });

      let launcherPrompt = '';
      setLauncher(async (opts) => {
        launcherPrompt = opts.prompt;
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: item.item_id });

      await runSpecFlowPhase(
        ctx.bb,
        item,
        { project_id: 'test-proj', local_path: '/tmp/test-project' },
        'test-session'
      );

      // Prompt should NOT contain prior work context
      expect(launcherPrompt).not.toContain('Prior Implementation Work Detected');
      // Original prompt should be passed through unchanged
      expect(launcherPrompt).toBe(implementPrompt);
    });
  });

  describe('detectMissingArtifacts', () => {
    test('detects docs.md missing from stderr', () => {
      const result = detectMissingArtifacts('', 'Error: docs.md is missing');
      expect(result).toEqual(['docs.md']);
    });

    test('detects verify.md not found from stdout', () => {
      const result = detectMissingArtifacts('verify.md not found', '');
      expect(result).toEqual(['verify.md']);
    });

    test('detects both missing', () => {
      const result = detectMissingArtifacts(
        'Required: docs.md not found, verify.md not found',
        ''
      );
      expect(result).toEqual(['docs.md', 'verify.md']);
    });

    test('detects generic missing artifacts message', () => {
      const result = detectMissingArtifacts('', 'missing artifacts for feature');
      expect(result).toEqual(['docs.md', 'verify.md']);
    });

    test('returns empty for unrelated errors', () => {
      const result = detectMissingArtifacts('', 'database connection error');
      expect(result).toEqual([]);
    });
  });
});
