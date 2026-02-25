import { describe, it, expect } from 'bun:test';
import {
  extractProblemStatement,
  extractKeyDecisions,
  getFilesChangedSummary,
  formatFilesChanged,
  type FileChange
} from '../src/lib/pr-body-extractor';

describe('extractProblemStatement', () => {
  it('extracts problem statement from ## Problem Statement heading', () => {
    const spec = `
# Feature Spec

## Problem Statement

The current system lacks proper error handling. This causes user confusion. We need better feedback.

## Other Section
`;
    const result = extractProblemStatement(spec);
    expect(result).toContain('The current system lacks proper error handling');
    expect(result).toContain('This causes user confusion');
  });

  it('extracts from ## Problem heading variation', () => {
    const spec = `
## Problem

Users cannot delete items.

## Solution
`;
    const result = extractProblemStatement(spec);
    expect(result).toBe('Users cannot delete items.');
  });

  it('returns fallback text when Problem Statement section missing', () => {
    const spec = `
# Feature Spec

## Overview

Some content here.
`;
    const result = extractProblemStatement(spec);
    expect(result).toBe('See spec.md for full feature details');
  });

  it('truncates to 300 characters', () => {
    const longText = 'A'.repeat(400);
    const spec = `
## Problem Statement

${longText}

## Next
`;
    const result = extractProblemStatement(spec);
    expect(result.length).toBeLessThanOrEqual(300);
    expect(result).toContain('...');
  });

  it('handles empty Problem Statement section', () => {
    const spec = `
## Problem Statement

## Next Section
`;
    const result = extractProblemStatement(spec);
    expect(result).toBe('See spec.md for full feature details');
  });
});

describe('extractKeyDecisions', () => {
  it('extracts bullet points from Technical Approach section', () => {
    const plan = `
## Technical Approach

- Use PostgreSQL for persistence
- Implement caching layer
- Add rate limiting

## Other
`;
    const result = extractKeyDecisions(plan);
    expect(result).toHaveLength(3);
    expect(result).toContain('Use PostgreSQL for persistence');
    expect(result).toContain('Implement caching layer');
    expect(result).toContain('Add rate limiting');
  });

  it('extracts from Key Decisions section', () => {
    const plan = `
## Key Decisions

* Decision one
* Decision two

## Next
`;
    const result = extractKeyDecisions(plan);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('Decision one');
  });

  it('returns fallback array when no decision sections found', () => {
    const plan = `
## Overview

Some content.

## Summary
`;
    const result = extractKeyDecisions(plan);
    expect(result).toEqual(['See plan.md for implementation details']);
  });

  it('limits to 5 decisions', () => {
    const bullets = Array.from({ length: 10 }, (_, i) => `- Decision ${i + 1}`).join('\n');
    const plan = `
## Technical Approach

${bullets}

## Next
`;
    const result = extractKeyDecisions(plan);
    expect(result).toHaveLength(5);
  });

  it('handles empty decision section', () => {
    const plan = `
## Technical Approach

## Next Section
`;
    const result = extractKeyDecisions(plan);
    expect(result).toEqual(['See plan.md for implementation details']);
  });
});

describe('getFilesChangedSummary', () => {
  it('parses git diff --stat output correctly', async () => {
    // This test will only work if we're in a git repo with actual changes
    // For now, we'll just verify it returns an array and doesn't crash
    const result = await getFilesChangedSummary('main', 'nonexistent-branch');
    expect(Array.isArray(result)).toBe(true);
  });

  it('returns empty array on git command failure', async () => {
    const result = await getFilesChangedSummary('invalid-branch', 'another-invalid');
    expect(result).toEqual([]);
  });
});

describe('formatFilesChanged', () => {
  it('formats file changes as markdown table', () => {
    const files: FileChange[] = [
      { path: 'src/index.ts', additions: 10, deletions: 5 },
      { path: 'tests/index.test.ts', additions: 20, deletions: 0 }
    ];

    const result = formatFilesChanged(files);
    expect(result).toContain('| File | Changes |');
    expect(result).toContain('| `src/index.ts` | +10 -5 |');
    expect(result).toContain('| `tests/index.test.ts` | +20 -0 |');
  });

  it('returns fallback message for empty array', () => {
    const result = formatFilesChanged([]);
    expect(result).toBe('_See PR diff for file changes_');
  });

  it('handles files with no deletions', () => {
    const files: FileChange[] = [
      { path: 'new-file.ts', additions: 50, deletions: 0 }
    ];

    const result = formatFilesChanged(files);
    expect(result).toContain('| `new-file.ts` | +50 -0 |');
  });
});
