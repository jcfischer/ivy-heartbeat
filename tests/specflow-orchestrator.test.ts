import { describe, it, expect } from 'bun:test';
import { determineAction } from '../src/scheduler/specflow/orchestrator.ts';
import type { SpecFlowFeature } from 'ivy-blackboard/src/types';

// ─── Feature factory ──────────────────────────────────────────────────

function makeFeature(overrides: Partial<SpecFlowFeature> = {}): SpecFlowFeature {
  return {
    feature_id: 'F-TEST',
    project_id: 'test-project',
    title: 'Test Feature',
    description: null,
    phase: 'queued',
    status: 'pending',
    current_session: null,
    worktree_path: null,
    branch_name: null,
    main_branch: 'main',
    failure_count: 0,
    max_failures: 3,
    last_error: null,
    last_phase_error: null,
    specify_score: null,
    plan_score: null,
    implement_score: null,
    pr_number: null,
    pr_url: null,
    commit_sha: null,
    github_issue_number: null,
    github_issue_url: null,
    github_repo: null,
    source: 'specflow',
    source_ref: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    phase_started_at: null,
    completed_at: null,
    ...overrides,
  };
}

// ─── determineAction tests ─────────────────────────────────────────────

describe('determineAction', () => {
  describe('terminal states', () => {
    it('returns wait for completed phase', () => {
      const action = determineAction(makeFeature({ phase: 'completed', status: 'succeeded' }));
      expect(action.type).toBe('wait');
      expect((action as { reason: string }).reason).toBe('terminal state');
    });

    it('returns wait for failed phase', () => {
      const action = determineAction(makeFeature({ phase: 'failed', status: 'failed' }));
      expect(action.type).toBe('wait');
      expect((action as { reason: string }).reason).toBe('terminal state');
    });
  });

  describe('blocked status', () => {
    it('returns wait when blocked', () => {
      const action = determineAction(makeFeature({ status: 'blocked' }));
      expect(action.type).toBe('wait');
      expect((action as { reason: string }).reason).toBe('blocked');
    });
  });

  describe('max failures', () => {
    it('returns fail when failure_count >= max_failures', () => {
      const action = determineAction(makeFeature({ failure_count: 3, max_failures: 3 }));
      expect(action.type).toBe('fail');
      expect((action as { reason: string }).reason).toContain('max failures');
    });

    it('returns fail when failure_count exceeds max_failures', () => {
      const action = determineAction(makeFeature({ failure_count: 5, max_failures: 3 }));
      expect(action.type).toBe('fail');
    });

    it('does NOT fail when failure_count is below max_failures', () => {
      // specifying + pending (retry) should run-phase, not fail
      const action = determineAction(makeFeature({ phase: 'specifying', failure_count: 2, max_failures: 3, status: 'pending' }));
      expect(action.type).toBe('run-phase');
    });
  });

  describe('active session handling', () => {
    it('returns wait when session is active and not stale', () => {
      const recentStart = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
      const action = determineAction(makeFeature({
        status: 'active',
        current_session: 'session-123',
        phase_started_at: recentStart,
        phase: 'specifying',
      }), 90);
      expect(action.type).toBe('wait');
      expect((action as { reason: string }).reason).toBe('session active');
    });

    it('returns release when session is stale', () => {
      const staleStart = new Date(Date.now() - 120 * 60 * 1000).toISOString(); // 2 hours ago
      const action = determineAction(makeFeature({
        status: 'active',
        current_session: 'session-old',
        phase_started_at: staleStart,
        phase: 'specifying',
      }), 90);
      expect(action.type).toBe('release');
      expect((action as { reason: string }).reason).toContain('timeout');
    });

    it('returns release when phase_started_at is null', () => {
      const action = determineAction(makeFeature({
        status: 'active',
        current_session: 'session-123',
        phase_started_at: null,
        phase: 'specifying',
      }), 90);
      expect(action.type).toBe('release');
    });
  });

  describe('gate checking (*ing + succeeded)', () => {
    it('returns check-gate for specifying + succeeded', () => {
      const action = determineAction(makeFeature({ phase: 'specifying', status: 'succeeded' }));
      expect(action.type).toBe('check-gate');
      expect((action as { gate: string }).gate).toBe('quality');
    });

    it('returns check-gate for planning + succeeded', () => {
      const action = determineAction(makeFeature({ phase: 'planning', status: 'succeeded' }));
      expect(action.type).toBe('check-gate');
      expect((action as { gate: string }).gate).toBe('quality');
    });

    it('returns check-gate for tasking + succeeded', () => {
      const action = determineAction(makeFeature({ phase: 'tasking', status: 'succeeded' }));
      expect(action.type).toBe('check-gate');
      expect((action as { gate: string }).gate).toBe('artifact');
    });

    it('returns check-gate for implementing + succeeded', () => {
      const action = determineAction(makeFeature({ phase: 'implementing', status: 'succeeded' }));
      expect(action.type).toBe('check-gate');
      expect((action as { gate: string }).gate).toBe('code');
    });

    it('returns check-gate for completing + succeeded', () => {
      const action = determineAction(makeFeature({ phase: 'completing', status: 'succeeded' }));
      expect(action.type).toBe('check-gate');
      expect((action as { gate: string }).gate).toBe('pass');
    });
  });

  describe('phase advancement (*ed + pending)', () => {
    it('advances from specified to planning', () => {
      const action = determineAction(makeFeature({ phase: 'specified', status: 'pending' }));
      expect(action.type).toBe('advance');
      expect((action as { fromPhase: string; toPhase: string }).fromPhase).toBe('specified');
      expect((action as { fromPhase: string; toPhase: string }).toPhase).toBe('planning');
    });

    it('advances from planned to tasking', () => {
      const action = determineAction(makeFeature({ phase: 'planned', status: 'pending' }));
      expect(action.type).toBe('advance');
      expect((action as { toPhase: string }).toPhase).toBe('tasking');
    });

    it('advances from tasked to implementing', () => {
      const action = determineAction(makeFeature({ phase: 'tasked', status: 'pending' }));
      expect(action.type).toBe('advance');
      expect((action as { toPhase: string }).toPhase).toBe('implementing');
    });

    it('advances from implemented to completing', () => {
      const action = determineAction(makeFeature({ phase: 'implemented', status: 'pending' }));
      expect(action.type).toBe('advance');
      expect((action as { toPhase: string }).toPhase).toBe('completing');
    });
  });

  describe('run-phase (pending + no active session)', () => {
    it('advances queued → specifying (queued ends with ed)', () => {
      // 'queued' ends with 'ed' so it goes through ADVANCE_MAP → specifying
      const action = determineAction(makeFeature({ phase: 'queued', status: 'pending' }));
      expect(action.type).toBe('advance');
      expect((action as { toPhase: string }).toPhase).toBe('specifying');
    });

    it('returns run-phase for specifying + pending (first run or retry)', () => {
      const action = determineAction(makeFeature({ phase: 'specifying', status: 'pending' }));
      expect(action.type).toBe('run-phase');
      expect((action as { phase: string }).phase).toBe('specifying');
    });

    it('returns run-phase for specifying + pending (retry)', () => {
      const action = determineAction(makeFeature({ phase: 'specifying', status: 'pending' }));
      expect(action.type).toBe('run-phase');
      expect((action as { phase: string }).phase).toBe('specifying');
    });

    it('returns run-phase for implementing + pending (retry)', () => {
      const action = determineAction(makeFeature({ phase: 'implementing', status: 'pending' }));
      expect(action.type).toBe('run-phase');
    });
  });

  describe('edge cases', () => {
    it('priority: terminal check before max_failures check', () => {
      const action = determineAction(makeFeature({
        phase: 'completed',
        status: 'succeeded',
        failure_count: 10,
        max_failures: 3,
      }));
      expect(action.type).toBe('wait'); // terminal wins
    });

    it('priority: blocked check before max_failures check', () => {
      const action = determineAction(makeFeature({
        phase: 'specifying',
        status: 'blocked',
        failure_count: 10,
        max_failures: 3,
      }));
      expect(action.type).toBe('wait'); // blocked wins
    });
  });
});
