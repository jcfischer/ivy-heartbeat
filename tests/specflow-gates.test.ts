import { describe, it, expect } from 'bun:test';
import { CODE_GATE_EXCLUSIONS } from '../src/scheduler/specflow/gates/code-gate.ts';

// ─── Code gate exclusion logic tests ──────────────────────────────────
// We test the filtering logic directly since checkCodeGate() calls git.

function applyCodeGateFilter(changedFiles: string[]): string[] {
  return changedFiles.filter(
    (f) => !CODE_GATE_EXCLUSIONS.some(
      (excl) => f.startsWith(excl) || f === excl.replace(/\/$/, ''),
    ),
  );
}

describe('CODE_GATE_EXCLUSIONS', () => {
  it('includes expected exclusion paths', () => {
    expect(CODE_GATE_EXCLUSIONS).toContain('.specify/');
    expect(CODE_GATE_EXCLUSIONS).toContain('CHANGELOG.md');
    expect(CODE_GATE_EXCLUSIONS).toContain('Plans/');
    expect(CODE_GATE_EXCLUSIONS).toContain('docs/');
    expect(CODE_GATE_EXCLUSIONS).toContain('README.md');
    expect(CODE_GATE_EXCLUSIONS).toContain('.claude/');
    expect(CODE_GATE_EXCLUSIONS).toContain('verify.md');
    expect(CODE_GATE_EXCLUSIONS).toContain('.specflow/');
  });

  it('does NOT exclude test files (tests are valid implementation)', () => {
    const files = ['tests/my-feature.test.ts'];
    const sourceFiles = applyCodeGateFilter(files);
    expect(sourceFiles).toEqual(files);
  });
});

describe('code gate filtering logic', () => {
  it('passes with real source files', () => {
    const changedFiles = [
      'src/scheduler/specflow/orchestrator.ts',
      'src/evaluators/specflow-orchestrate.ts',
    ];
    const sourceFiles = applyCodeGateFilter(changedFiles);
    expect(sourceFiles.length).toBe(2);
  });

  it('fails when only spec artifacts changed', () => {
    const changedFiles = [
      '.specify/specs/f-023-feature/spec.md',
      '.specify/specs/f-023-feature/plan.md',
      'CHANGELOG.md',
    ];
    const sourceFiles = applyCodeGateFilter(changedFiles);
    expect(sourceFiles.length).toBe(0);
  });

  it('fails with only Plans/ files (FM-3 regression)', () => {
    const changedFiles = [
      'Plans/goofy-inventing-llama.md',
      'CHANGELOG.md',
    ];
    const sourceFiles = applyCodeGateFilter(changedFiles);
    expect(sourceFiles.length).toBe(0);
  });

  it('passes with mix of source and spec files', () => {
    const changedFiles = [
      'src/scheduler/specflow/orchestrator.ts',
      '.specify/specs/f-027/spec.md',
      'CHANGELOG.md',
    ];
    const sourceFiles = applyCodeGateFilter(changedFiles);
    expect(sourceFiles).toEqual(['src/scheduler/specflow/orchestrator.ts']);
  });

  it('fails with only docs/ files', () => {
    const changedFiles = [
      'docs/architecture.md',
      'docs/api.md',
    ];
    const sourceFiles = applyCodeGateFilter(changedFiles);
    expect(sourceFiles.length).toBe(0);
  });

  it('fails with only README.md', () => {
    const changedFiles = ['README.md'];
    const sourceFiles = applyCodeGateFilter(changedFiles);
    expect(sourceFiles.length).toBe(0);
  });

  it('fails with only verify.md', () => {
    const changedFiles = ['verify.md'];
    const sourceFiles = applyCodeGateFilter(changedFiles);
    expect(sourceFiles.length).toBe(0);
  });

  it('fails with only .specflow/ files', () => {
    const changedFiles = ['.specflow/state.db'];
    const sourceFiles = applyCodeGateFilter(changedFiles);
    expect(sourceFiles.length).toBe(0);
  });

  it('passes with empty diff (nothing changed)', () => {
    const sourceFiles = applyCodeGateFilter([]);
    expect(sourceFiles.length).toBe(0);
    // passes=false because no source files, even if also no excluded files
  });

  it('passes with test files (tests are valid source)', () => {
    const changedFiles = [
      'tests/specflow-orchestrator.test.ts',
      'tests/specflow-gates.test.ts',
    ];
    const sourceFiles = applyCodeGateFilter(changedFiles);
    expect(sourceFiles.length).toBe(2);
  });

  it('excludes nested .specify/ files', () => {
    const changedFiles = [
      '.specify/specs/f-027/plan.md',
      '.specify/specs/f-027/tasks.md',
      '.specify/specflow.db',
    ];
    const sourceFiles = applyCodeGateFilter(changedFiles);
    expect(sourceFiles.length).toBe(0);
  });

  it('excludes nested .claude/ files', () => {
    const changedFiles = ['.claude/memory/decisions.md'];
    const sourceFiles = applyCodeGateFilter(changedFiles);
    expect(sourceFiles.length).toBe(0);
  });
});
