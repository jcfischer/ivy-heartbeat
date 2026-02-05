import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, cleanupTestContext, type TestContext } from './helpers.ts';
import { registerProject } from 'ivy-blackboard/src/project';

// ─── Helpers ──────────────────────────────────────────────────────────

let ctx: TestContext;

function seedProject(id: string, path: string, metadata?: Record<string, unknown>): void {
  registerProject(ctx.bb.db, { id, name: id, path });
  if (metadata) {
    ctx.bb.db
      .prepare('UPDATE projects SET metadata = ? WHERE project_id = ?')
      .run(JSON.stringify(metadata), id);
  }
}

// ─── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  cleanupTestContext(ctx);
});

// ─── Tests ────────────────────────────────────────────────────────────

describe('specflow-queue', () => {
  describe('work item creation', () => {
    test('valid project + feature creates work item with correct metadata', () => {
      seedProject('test-proj', '/tmp/test-project', { specflow_enabled: true });

      ctx.bb.createWorkItem({
        id: 'specflow-F-019-specify',
        title: 'SpecFlow specify: F-019',
        description: 'SpecFlow feature "F-019" — starting with specify phase (batch mode)',
        project: 'test-proj',
        source: 'specflow',
        sourceRef: 'F-019',
        priority: 'P2',
        metadata: JSON.stringify({
          specflow_feature_id: 'F-019',
          specflow_phase: 'specify',
          specflow_project_id: 'test-proj',
        }),
      });

      const items = ctx.bb.listWorkItems({ all: true, project: 'test-proj' });
      expect(items).toHaveLength(1);
      expect(items[0].source).toBe('specflow');
      expect(items[0].source_ref).toBe('F-019');

      const meta = JSON.parse(items[0].metadata ?? '{}');
      expect(meta.specflow_feature_id).toBe('F-019');
      expect(meta.specflow_phase).toBe('specify');
      expect(meta.specflow_project_id).toBe('test-proj');
    });
  });

  describe('validation', () => {
    test('project without specflow_enabled is detected', () => {
      seedProject('no-specflow', '/tmp/no-specflow', {});

      const project = ctx.bb.getProject('no-specflow');
      expect(project).toBeDefined();

      let projectMeta: Record<string, unknown> = {};
      if (project!.metadata) {
        try {
          projectMeta = JSON.parse(project!.metadata as string);
        } catch { /* */ }
      }

      expect(projectMeta.specflow_enabled).toBeFalsy();
    });

    test('nonexistent project is detected', () => {
      const project = ctx.bb.getProject('nonexistent');
      expect(project).toBeNull();
    });

    test('duplicate work item detection', () => {
      seedProject('test-proj', '/tmp/test-project', { specflow_enabled: true });

      // Create first work item
      ctx.bb.createWorkItem({
        id: 'specflow-F-001-specify',
        title: 'SpecFlow specify: F-001',
        project: 'test-proj',
        source: 'specflow',
        sourceRef: 'F-001',
        priority: 'P2',
        metadata: JSON.stringify({
          specflow_feature_id: 'F-001',
          specflow_phase: 'specify',
          specflow_project_id: 'test-proj',
        }),
      });

      // Check for duplicate
      const existingItems = ctx.bb.listWorkItems({ all: true, project: 'test-proj' });
      const duplicate = existingItems.some((item) => {
        if (!item.metadata) return false;
        try {
          const meta = JSON.parse(item.metadata);
          return (
            meta.specflow_feature_id === 'F-001' &&
            item.status !== 'completed' &&
            item.status !== 'failed'
          );
        } catch {
          return false;
        }
      });

      expect(duplicate).toBe(true);
    });

    test('completed work items do not count as duplicates', () => {
      seedProject('test-proj', '/tmp/test-project', { specflow_enabled: true });

      // Create and complete a work item
      ctx.bb.createWorkItem({
        id: 'specflow-F-001-specify',
        title: 'SpecFlow specify: F-001',
        project: 'test-proj',
        source: 'specflow',
        sourceRef: 'F-001',
        priority: 'P2',
        metadata: JSON.stringify({
          specflow_feature_id: 'F-001',
          specflow_phase: 'specify',
          specflow_project_id: 'test-proj',
        }),
      });

      // Claim and complete it
      const agent = ctx.bb.registerAgent({ name: 'test', project: 'test-proj', work: 'specflow-F-001-specify' });
      ctx.bb.claimWorkItem('specflow-F-001-specify', agent.session_id);
      ctx.bb.completeWorkItem('specflow-F-001-specify', agent.session_id);

      // Now check — completed items should NOT be duplicates
      const existingItems = ctx.bb.listWorkItems({ all: true, project: 'test-proj' });
      const duplicate = existingItems.some((item) => {
        if (!item.metadata) return false;
        try {
          const meta = JSON.parse(item.metadata);
          return (
            meta.specflow_feature_id === 'F-001' &&
            item.status !== 'completed' &&
            item.status !== 'failed'
          );
        } catch {
          return false;
        }
      });

      expect(duplicate).toBe(false);
    });
  });
});
