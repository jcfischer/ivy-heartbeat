import { test, expect, describe, mock, beforeEach, afterEach } from 'bun:test';
import { formatCommentsForPrompt } from '../src/scheduler/pr-comments.ts';
import type { Review, InlineComment } from '../src/scheduler/pr-comments.ts';

// Note: fetchPRComments depends on `gh` CLI and is tested via integration.
// Unit tests focus on formatCommentsForPrompt and the data interfaces.

describe('formatCommentsForPrompt', () => {
  test('formats changes_requested reviews with author', () => {
    const reviews: Review[] = [
      {
        id: 1,
        body: 'Please fix the SQL injection on line 42',
        state: 'CHANGES_REQUESTED',
        author: 'reviewer1',
        submitted_at: '2026-01-15T10:00:00Z',
      },
    ];
    const result = formatCommentsForPrompt(reviews, []);
    expect(result).toContain('## Review Comments');
    expect(result).toContain('### Review by @reviewer1');
    expect(result).toContain('Please fix the SQL injection on line 42');
  });

  test('skips approved reviews', () => {
    const reviews: Review[] = [
      {
        id: 1,
        body: 'Looks great!',
        state: 'APPROVED',
        author: 'reviewer1',
        submitted_at: '2026-01-15T10:00:00Z',
      },
    ];
    const result = formatCommentsForPrompt(reviews, []);
    expect(result).not.toContain('Looks great!');
    expect(result).not.toContain('## Review Comments');
  });

  test('skips changes_requested reviews with empty body', () => {
    const reviews: Review[] = [
      {
        id: 1,
        body: '',
        state: 'CHANGES_REQUESTED',
        author: 'reviewer1',
        submitted_at: '2026-01-15T10:00:00Z',
      },
    ];
    const result = formatCommentsForPrompt(reviews, []);
    expect(result).not.toContain('## Review Comments');
  });

  test('formats inline comments with file path and line number', () => {
    const comments: InlineComment[] = [
      {
        path: 'src/auth.ts',
        line: 42,
        body: 'This needs input validation',
        author: 'reviewer1',
        created_at: '2026-01-15T10:00:00Z',
      },
      {
        path: 'src/db.ts',
        line: 15,
        body: 'Use parameterized queries',
        author: 'reviewer2',
        created_at: '2026-01-15T10:05:00Z',
      },
    ];
    const result = formatCommentsForPrompt([], comments);
    expect(result).toContain('## File-Level Comments');
    expect(result).toContain('### src/auth.ts:42');
    expect(result).toContain('> This needs input validation');
    expect(result).toContain('— @reviewer1');
    expect(result).toContain('### src/db.ts:15');
    expect(result).toContain('> Use parameterized queries');
    expect(result).toContain('— @reviewer2');
  });

  test('combines reviews and inline comments', () => {
    const reviews: Review[] = [
      {
        id: 1,
        body: 'Several issues found',
        state: 'CHANGES_REQUESTED',
        author: 'lead',
        submitted_at: '2026-01-15T10:00:00Z',
      },
    ];
    const comments: InlineComment[] = [
      {
        path: 'src/index.ts',
        line: 1,
        body: 'Missing import',
        author: 'lead',
        created_at: '2026-01-15T10:00:00Z',
      },
    ];
    const result = formatCommentsForPrompt(reviews, comments);
    expect(result).toContain('## Review Comments');
    expect(result).toContain('Several issues found');
    expect(result).toContain('## File-Level Comments');
    expect(result).toContain('### src/index.ts:1');
  });

  test('returns empty string when no relevant reviews or comments', () => {
    const result = formatCommentsForPrompt([], []);
    expect(result).toBe('');
  });

  test('handles multiple changes_requested reviews', () => {
    const reviews: Review[] = [
      {
        id: 1,
        body: 'Fix auth',
        state: 'CHANGES_REQUESTED',
        author: 'alice',
        submitted_at: '2026-01-15T10:00:00Z',
      },
      {
        id: 2,
        body: 'Fix tests',
        state: 'CHANGES_REQUESTED',
        author: 'bob',
        submitted_at: '2026-01-15T11:00:00Z',
      },
    ];
    const result = formatCommentsForPrompt(reviews, []);
    expect(result).toContain('### Review by @alice');
    expect(result).toContain('### Review by @bob');
    expect(result).toContain('Fix auth');
    expect(result).toContain('Fix tests');
  });
});

describe('InlineComment interface', () => {
  test('all required fields are present', () => {
    const comment: InlineComment = {
      path: 'src/test.ts',
      line: 10,
      body: 'Fix this',
      author: 'reviewer',
      created_at: '2026-01-15T10:00:00Z',
    };
    expect(comment.path).toBe('src/test.ts');
    expect(comment.line).toBe(10);
    expect(comment.body).toBe('Fix this');
    expect(comment.author).toBe('reviewer');
    expect(comment.created_at).toBe('2026-01-15T10:00:00Z');
  });
});
