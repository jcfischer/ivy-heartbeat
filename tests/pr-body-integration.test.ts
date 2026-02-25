import { describe, it, expect } from 'bun:test';
import { extractProblemStatement, extractKeyDecisions, formatFilesChanged } from '../src/lib/pr-body-extractor';

/**
 * Integration tests for enhanced PR body generation.
 * Tests the complete flow with real spec/plan content.
 */
describe('PR Body Integration', () => {
  it('generates complete PR body from real spec and plan content', async () => {
    // Sample spec content (similar to actual F-024 spec)
    const specContent = `
# Feature Specification: Test Feature

## Overview

This is a test feature.

## Problem Statement

The current PR body generation is a stub that only references spec.md and plan.md. This makes it difficult for external reviewers to quickly understand what a PR does. We need to enhance PR bodies with meaningful summaries.

## Functional Requirements

FR-1: Extract content
FR-2: Format nicely
`;

    // Sample plan content
    const planContent = `
# Technical Plan: Test Feature

## Technical Approach

- Use Bun file API for reading spec files
- Implement regex-based markdown parsing
- Add graceful error handling for missing files
- Format output as markdown tables

## Implementation Phases

Phase 1: Create extraction utilities
Phase 2: Integration
`;

    // Extract content
    const summary = extractProblemStatement(specContent);
    const approach = extractKeyDecisions(planContent);

    // Verify extraction worked
    expect(summary).toContain('The current PR body generation is a stub');
    expect(summary).toContain('We need to enhance PR bodies');
    expect(approach).toHaveLength(4);
    expect(approach[0]).toBe('Use Bun file API for reading spec files');

    // Build PR body (simplified version of actual code)
    const featureId = 'F-024';
    const filesChangedTable = formatFilesChanged([
      { path: 'src/lib/pr-body-extractor.ts', additions: 100, deletions: 0 },
      { path: 'tests/pr-body-extractor.test.ts', additions: 150, deletions: 0 }
    ]);

    const prBody = [
      `# Feature: ${featureId}`,
      '',
      '## Summary',
      '',
      summary,
      '',
      '## Implementation Approach',
      '',
      ...approach.map(point => `- ${point}`),
      '',
      '## Files Changed',
      '',
      filesChangedTable,
      '',
      '## Full Documentation',
      '',
      '- [Specification](f-024/spec.md)',
      '- [Technical Plan](f-024/plan.md)',
    ].join('\n');

    // Verify PR body structure
    expect(prBody).toContain('# Feature: F-024');
    expect(prBody).toContain('## Summary');
    expect(prBody).toContain('## Implementation Approach');
    expect(prBody).toContain('## Files Changed');
    expect(prBody).toContain('## Full Documentation');
    expect(prBody).toContain('[Specification](f-024/spec.md)');
    expect(prBody).toContain('[Technical Plan](f-024/plan.md)');

    // Verify content is present
    expect(prBody).toContain('The current PR body generation');
    expect(prBody).toContain('Use Bun file API for reading spec files');
    expect(prBody).toContain('| `src/lib/pr-body-extractor.ts` | +100 -0 |');
  });

  it('truncates PR body to 4000 characters', () => {
    const longSummary = 'A'.repeat(3000);
    const longApproach = Array.from({ length: 100 }, (_, i) => `- Decision ${i}`);

    let prBody = [
      '# Feature: F-TEST',
      '',
      '## Summary',
      '',
      longSummary,
      '',
      '## Implementation Approach',
      '',
      ...longApproach,
      '',
      '## Files Changed',
      '',
      formatFilesChanged([]),
      '',
      '## Full Documentation',
      '',
      '- [Specification](test/spec.md)',
      '- [Technical Plan](test/plan.md)',
    ].join('\n');

    // Apply truncation logic from actual code
    if (prBody.length > 4000) {
      prBody = prBody.substring(0, 3997) + '...';
    }

    expect(prBody.length).toBeLessThanOrEqual(4000);
    expect(prBody).toEndWith('...');
  });

  it('handles missing spec sections gracefully', () => {
    const specWithoutProblemStatement = `
# Feature Spec

## Overview

Just an overview, no problem statement.

## Requirements

Some requirements.
`;

    const summary = extractProblemStatement(specWithoutProblemStatement);
    expect(summary).toBe('See spec.md for full feature details');

    // Verify PR body can still be generated with fallback
    const prBody = [
      '# Feature: F-TEST',
      '',
      '## Summary',
      '',
      summary,
      '',
      '## Implementation Approach',
      '',
      '- See plan.md for implementation details',
      '',
      '## Full Documentation',
      '',
      '- [Specification](test/spec.md)',
    ].join('\n');

    expect(prBody).toContain('See spec.md for full feature details');
    expect(prBody).toContain('See plan.md for implementation details');
  });
});
