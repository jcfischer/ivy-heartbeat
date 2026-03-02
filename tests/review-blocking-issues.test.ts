import { test, expect, describe } from 'bun:test';
import {
  parseReviewResult,
  buildReviewPrompt,
  type BlockingIssue,
} from '../src/scheduler/review-agent.ts';

describe('parseReviewResult - blocking issues extraction', () => {
  test('extracts blocking issues from structured output', () => {
    const output = `
REVIEW_RESULT: changes_requested
FINDINGS_COUNT: 2
SEVERITY: critical
SUMMARY: No implementation code found, only specification artifacts
BLOCKING_ISSUES: [{"severity":"critical","description":"No implementation code found"}]
    `.trim();

    const result = parseReviewResult(output);
    expect(result.status).toBe('changes_requested');
    expect(result.blockingIssues).toHaveLength(1);
    expect(result.blockingIssues[0].severity).toBe('critical');
    expect(result.blockingIssues[0].description).toBe('No implementation code found');
  });

  test('extracts multiple blocking issues', () => {
    const output = `
REVIEW_RESULT: changes_requested
FINDINGS_COUNT: 3
SEVERITY: high
SUMMARY: Multiple issues found
BLOCKING_ISSUES: [{"severity":"critical","description":"No implementation"},{"severity":"high","description":"Missing tests"}]
    `.trim();

    const result = parseReviewResult(output);
    expect(result.blockingIssues).toHaveLength(2);
    expect(result.blockingIssues[0].severity).toBe('critical');
    expect(result.blockingIssues[1].severity).toBe('high');
  });

  test('handles empty blocking issues array', () => {
    const output = `
REVIEW_RESULT: approved
FINDINGS_COUNT: 0
SEVERITY: low
SUMMARY: All looks good
BLOCKING_ISSUES: []
    `.trim();

    const result = parseReviewResult(output);
    expect(result.status).toBe('approved');
    expect(result.blockingIssues).toHaveLength(0);
  });

  test('handles missing BLOCKING_ISSUES field', () => {
    const output = `
REVIEW_RESULT: approved
FINDINGS_COUNT: 0
SEVERITY: low
SUMMARY: All looks good
    `.trim();

    const result = parseReviewResult(output);
    expect(result.blockingIssues).toHaveLength(0);
  });

  test('handles invalid JSON in blocking issues', () => {
    const output = `
REVIEW_RESULT: changes_requested
FINDINGS_COUNT: 1
SEVERITY: medium
SUMMARY: Issues found
BLOCKING_ISSUES: [not valid json]
    `.trim();

    const result = parseReviewResult(output);
    expect(result.blockingIssues).toHaveLength(0);
  });

  test('filters out malformed blocking issue objects', () => {
    const output = `
REVIEW_RESULT: changes_requested
FINDINGS_COUNT: 2
SEVERITY: high
SUMMARY: Issues found
BLOCKING_ISSUES: [{"severity":"critical","description":"Valid"},{"missing":"fields"},{"severity":"high"}]
    `.trim();

    const result = parseReviewResult(output);
    expect(result.blockingIssues).toHaveLength(1);
    expect(result.blockingIssues[0].description).toBe('Valid');
  });
});

describe('buildReviewPrompt - prior blocking issues', () => {
  test('includes prior blocking issues in prompt', () => {
    const priorIssues: BlockingIssue[] = [
      { severity: 'critical', description: 'No implementation code found', cycle: 1, resolved: false },
      { severity: 'high', description: 'Missing error handling', cycle: 1, resolved: false },
    ];

    const prompt = buildReviewPrompt({
      prNumber: 123,
      repo: 'owner/repo',
      branch: 'fix/issue',
      projectPath: '/path',
      priorBlockingIssues: priorIssues,
    });

    expect(prompt).toContain('CRITICAL: Unresolved Blocking Issues from Prior Cycles');
    expect(prompt).toContain('No implementation code found');
    expect(prompt).toContain('Missing error handling');
    expect(prompt).toContain('[Cycle 1]');
  });

  test('separates issues by severity', () => {
    const priorIssues: BlockingIssue[] = [
      { severity: 'critical', description: 'Critical issue', cycle: 1, resolved: false },
      { severity: 'high', description: 'High issue', cycle: 1, resolved: false },
      { severity: 'medium', description: 'Medium issue', cycle: 2, resolved: false },
      { severity: 'low', description: 'Low issue', cycle: 2, resolved: false },
    ];

    const prompt = buildReviewPrompt({
      prNumber: 123,
      repo: 'owner/repo',
      branch: 'fix/issue',
      projectPath: '/path',
      priorBlockingIssues: priorIssues,
    });

    expect(prompt).toContain('Critical Issues (MUST be resolved)');
    expect(prompt).toContain('High-Severity Issues (MUST be resolved)');
    expect(prompt).toContain('Other Issues (should be resolved)');
  });

  test('skips resolved issues', () => {
    const priorIssues: BlockingIssue[] = [
      { severity: 'critical', description: 'Already fixed', cycle: 1, resolved: true },
      { severity: 'high', description: 'Still broken', cycle: 2, resolved: false },
    ];

    const prompt = buildReviewPrompt({
      prNumber: 123,
      repo: 'owner/repo',
      branch: 'fix/issue',
      projectPath: '/path',
      priorBlockingIssues: priorIssues,
    });

    expect(prompt).not.toContain('Already fixed');
    expect(prompt).toContain('Still broken');
  });

  test('omits prior issues section when none exist', () => {
    const prompt = buildReviewPrompt({
      prNumber: 123,
      repo: 'owner/repo',
      branch: 'fix/issue',
      projectPath: '/path',
    });

    expect(prompt).not.toContain('CRITICAL: Unresolved Blocking Issues');
    expect(prompt).toContain('You are a code review agent');
  });

  test('omits prior issues section when all are resolved', () => {
    const priorIssues: BlockingIssue[] = [
      { severity: 'critical', description: 'Fixed issue 1', cycle: 1, resolved: true },
      { severity: 'high', description: 'Fixed issue 2', cycle: 1, resolved: true },
    ];

    const prompt = buildReviewPrompt({
      prNumber: 123,
      repo: 'owner/repo',
      branch: 'fix/issue',
      projectPath: '/path',
      priorBlockingIssues: priorIssues,
    });

    expect(prompt).not.toContain('CRITICAL: Unresolved Blocking Issues');
  });

  test('tracks issues across multiple cycles', () => {
    const priorIssues: BlockingIssue[] = [
      { severity: 'critical', description: 'Issue from cycle 1', cycle: 1, resolved: false },
      { severity: 'high', description: 'Issue from cycle 2', cycle: 2, resolved: false },
      { severity: 'medium', description: 'Issue from cycle 3', cycle: 3, resolved: false },
    ];

    const prompt = buildReviewPrompt({
      prNumber: 123,
      repo: 'owner/repo',
      branch: 'fix/issue',
      projectPath: '/path',
      priorBlockingIssues: priorIssues,
    });

    expect(prompt).toContain('[Cycle 1]');
    expect(prompt).toContain('[Cycle 2]');
    expect(prompt).toContain('[Cycle 3]');
  });
});
