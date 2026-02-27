import { describe, test, expect, mock } from 'bun:test';
import { getSpecFlowFeaturesView } from '../src/serve/api/specflow-pipeline.ts';
import { renderSpecFlowPanel, phaseState, DISPLAY_PHASES } from '../src/serve/views/specflow-panel.ts';
import type { SpecFlowFeature } from '../src/blackboard.ts';

function mockFeature(overrides: Partial<SpecFlowFeature> = {}): SpecFlowFeature {
  return {
    feature_id: 'f-001',
    project_id: 'ivy',
    title: 'Test Feature',
    description: null,
    phase: 'implementing',
    status: 'active',
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
    source: 'manual',
    source_ref: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    phase_started_at: new Date().toISOString(),
    completed_at: null,
    ...overrides,
  };
}

// ── T-5.1: getSpecFlowFeaturesView adapter ──────────────────────────────────

describe('getSpecFlowFeaturesView', () => {
  test('returns exactly what bb.listFeatures() returns', () => {
    const mockFeatures = [mockFeature()];
    const bb = { listFeatures: mock(() => mockFeatures) } as any;
    expect(getSpecFlowFeaturesView(bb)).toBe(mockFeatures);
  });

  test('returns empty array when bb.listFeatures() returns undefined', () => {
    const bb = { listFeatures: mock(() => undefined) } as any;
    expect(getSpecFlowFeaturesView(bb)).toEqual([]);
  });

  test('returns empty array when bb.listFeatures() returns null', () => {
    const bb = { listFeatures: mock(() => null) } as any;
    expect(getSpecFlowFeaturesView(bb)).toEqual([]);
  });
});

// ── T-5.2: renderSpecFlowPanel view ────────────────────────────────────────

describe('renderSpecFlowPanel', () => {
  test('empty array renders placeholder', () => {
    const html = renderSpecFlowPanel([]);
    expect(html).toContain('No active SpecFlow features');
  });

  test('active feature renders 11 phase dots', () => {
    const html = renderSpecFlowPanel([mockFeature()]);
    const matches = html.match(/data-phase=/g);
    expect(matches?.length).toBe(11);
  });

  test('status=failed renders terminal badge instead of phase track', () => {
    const html = renderSpecFlowPanel([mockFeature({ status: 'failed', phase: 'implementing' })]);
    expect(html).toContain('failed');
    expect(html).not.toContain('data-phase=');
  });

  test('status=blocked renders orange blocked badge', () => {
    const html = renderSpecFlowPanel([mockFeature({ status: 'blocked', phase: 'implementing' })]);
    expect(html).toContain('blocked');
    expect(html).not.toContain('data-phase=');
  });

  test('XSS: script tag in title is escaped', () => {
    const html = renderSpecFlowPanel([mockFeature({ title: '<script>alert(1)</script>' })]);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  test('XSS: script tag in feature_id is escaped', () => {
    const html = renderSpecFlowPanel([mockFeature({ feature_id: '<script>x</script>' })]);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>x</script>');
  });

  test('scores render as "92 / 85 / –" format', () => {
    const html = renderSpecFlowPanel([
      mockFeature({ specify_score: 92, plan_score: 85, implement_score: null }),
    ]);
    // Check for 92 / 85 / – with ndash entity
    expect(html).toContain('92');
    expect(html).toContain('85');
    expect(html).toContain('&ndash;');
  });

  test('all-null scores render with three ndash entities', () => {
    const html = renderSpecFlowPanel([
      mockFeature({ specify_score: null, plan_score: null, implement_score: null }),
    ]);
    // The scores cell should have 3 ndash entities
    const ndashCount = (html.match(/&ndash;/g) || []).length;
    expect(ndashCount).toBeGreaterThanOrEqual(3);
  });

  test('PR link rendered for https:// URL', () => {
    const html = renderSpecFlowPanel([
      mockFeature({ pr_url: 'https://github.com/foo/bar/pull/42', pr_number: 42 }),
    ]);
    expect(html).toContain('<a href="https://github.com/foo/bar/pull/42"');
    expect(html).toContain('#42');
  });

  test('PR link omitted for javascript: URL', () => {
    const html = renderSpecFlowPanel([
      mockFeature({ pr_url: 'javascript:alert(1)', pr_number: 1 }),
    ]);
    expect(html).not.toContain('<a href="javascript:');
  });

  test('failure badge hidden when failure_count=0', () => {
    const html = renderSpecFlowPanel([mockFeature({ failure_count: 0 })]);
    // Badge should not have "0/3"
    expect(html).not.toContain('0/3');
  });

  test('failure badge orange when failure_count >= 1', () => {
    const html = renderSpecFlowPanel([
      mockFeature({ failure_count: 1, max_failures: 3 }),
    ]);
    expect(html).toContain('1/3');
    expect(html).toContain('#f97316');
  });

  test('failure badge red when failure_count equals max_failures', () => {
    const html = renderSpecFlowPanel([
      mockFeature({ failure_count: 3, max_failures: 3 }),
    ]);
    expect(html).toContain('3/3');
    expect(html).toContain('#ef4444');
  });

  test('performance: 50 features render in < 50ms', () => {
    const features = Array.from({ length: 50 }, (_, i) =>
      mockFeature({ feature_id: `f-${String(i).padStart(3, '0')}` }),
    );
    const start = performance.now();
    renderSpecFlowPanel(features);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

// ── phaseState helper ───────────────────────────────────────────────────────

describe('phaseState', () => {
  test('returns "completed" for phase before current phase', () => {
    const f = mockFeature({ phase: 'implementing' });
    expect(phaseState(f, 'queued')).toBe('completed');
    expect(phaseState(f, 'specified')).toBe('completed');
  });

  test('returns "active" for current *ing phase', () => {
    const f = mockFeature({ phase: 'implementing' });
    expect(phaseState(f, 'implementing')).toBe('active');
  });

  test('returns "completed" for current *ed phase (non-active)', () => {
    const f = mockFeature({ phase: 'specified' });
    expect(phaseState(f, 'specified')).toBe('completed');
  });

  test('returns "pending" for phase after current phase', () => {
    const f = mockFeature({ phase: 'implementing' });
    expect(phaseState(f, 'completing')).toBe('pending');
    expect(phaseState(f, 'completed')).toBe('pending');
  });

  test('returns "pending" for unknown phase', () => {
    const f = mockFeature({ phase: 'implementing' });
    expect(phaseState(f, 'unknown-phase')).toBe('pending');
  });
});
