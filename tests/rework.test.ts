import { test, expect, describe, mock, beforeEach } from 'bun:test';
import {
  parseReworkMeta,
  createReworkWorkItem,
  buildReworkPrompt,
  resolveMaxReworkCycles,
  MAX_REWORK_CYCLES,
  DEFAULT_MAX_REWORK_CYCLES,
} from '../src/scheduler/rework.ts';

// Mock blackboard
function createMockBb() {
  const events: any[] = [];
  const items: any[] = [];
  return {
    createWorkItem: mock((opts: any) => { items.push(opts); }),
    appendEvent: mock((ev: any) => { events.push(ev); }),
    listWorkItems: mock((_opts?: any) => [] as any[]),
    _events: events,
    _items: items,
  };
}

/** Mock blackboard with getProject and updateWorkItemMetadata support. */
function createFullMockBb(projectMeta?: Record<string, any>) {
  const events: any[] = [];
  const items: any[] = [];
  const updatedMetadata: any[] = [];
  return {
    createWorkItem: mock((opts: any) => { items.push(opts); }),
    appendEvent: mock((ev: any) => { events.push(ev); }),
    listWorkItems: mock((_opts?: any) => [] as any[]),
    getProject: mock((_id: string) => projectMeta ? ({
      project_id: 'test-proj',
      display_name: 'Test',
      local_path: '/tmp/test',
      remote_repo: null,
      registered_at: new Date().toISOString(),
      metadata: JSON.stringify(projectMeta),
    }) : null),
    updateWorkItemMetadata: mock((itemId: string, updates: any) => {
      updatedMetadata.push({ itemId, updates });
      return { updated: true };
    }),
    _events: events,
    _items: items,
    _updatedMetadata: updatedMetadata,
  };
}

describe('parseReworkMeta', () => {
  test('returns null for null metadata', () => {
    expect(parseReworkMeta(null)).toBeNull();
  });

  test('returns null for non-rework metadata', () => {
    expect(parseReworkMeta(JSON.stringify({ merge_fix: true, pr_number: 1 }))).toBeNull();
  });

  test('returns null for invalid JSON', () => {
    expect(parseReworkMeta('not json')).toBeNull();
  });

  test('parses valid rework metadata', () => {
    const meta = {
      rework: true,
      pr_number: 42,
      pr_url: 'https://github.com/owner/repo/pull/42',
      repo: 'owner/repo',
      branch: 'fix/issue-10',
      implementation_work_item_id: 'gh-repo-10',
      review_feedback: 'Fix the SQL injection',
      rework_cycle: 2,
      project_id: 'my-project',
    };
    const result = parseReworkMeta(JSON.stringify(meta));
    expect(result).not.toBeNull();
    expect(result!.rework).toBe(true);
    expect(result!.pr_number).toBe(42);
    expect(result!.repo).toBe('owner/repo');
    expect(result!.rework_cycle).toBe(2);
    expect(result!.review_feedback).toBe('Fix the SQL injection');
  });

  test('defaults rework_cycle to 1 if missing', () => {
    const meta = {
      rework: true,
      pr_number: 5,
      repo: 'o/r',
      branch: 'fix/1',
    };
    const result = parseReworkMeta(JSON.stringify(meta));
    expect(result!.rework_cycle).toBe(1);
  });
});

describe('createReworkWorkItem', () => {
  test('creates a work item with correct ID format', () => {
    const bb = createMockBb();
    const id = createReworkWorkItem(bb as any, {
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
      repo: 'o/r',
      branch: 'fix/issue-10',
      implementationWorkItemId: 'gh-r-10',
      reviewFeedback: 'Fix SQL injection',
      reworkCycle: 1,
      projectId: 'my-proj',
      originalTitle: 'Fix auth bug',
      sessionId: 'sess-1',
    });
    expect(id).toBe('rework-my-proj-pr-42-cycle-1');
    expect(bb.createWorkItem).toHaveBeenCalledTimes(1);
    const call = bb._items[0];
    expect(call.id).toBe('rework-my-proj-pr-42-cycle-1');
    expect(call.source).toBe('rework');
    expect(call.priority).toBe('P1');
  });

  test('returns null when cycle exceeds MAX_REWORK_CYCLES', () => {
    const bb = createMockBb();
    const id = createReworkWorkItem(bb as any, {
      prNumber: 42,
      prUrl: 'https://github.com/o/r/pull/42',
      repo: 'o/r',
      branch: 'fix/issue-10',
      implementationWorkItemId: 'gh-r-10',
      reviewFeedback: 'Fix it',
      reworkCycle: MAX_REWORK_CYCLES + 1,
      projectId: 'my-proj',
      originalTitle: 'Fix auth bug',
      sessionId: 'sess-1',
    });
    expect(id).toBeNull();
    expect(bb.createWorkItem).not.toHaveBeenCalled();
    // Should still log an event about hitting the limit
    expect(bb.appendEvent).toHaveBeenCalledTimes(1);
    expect(bb._events[0].summary).toContain('cycle limit reached');
  });

  test('includes review feedback in description', () => {
    const bb = createMockBb();
    createReworkWorkItem(bb as any, {
      prNumber: 7,
      prUrl: 'https://github.com/o/r/pull/7',
      repo: 'o/r',
      branch: 'fix/5',
      implementationWorkItemId: 'gh-r-5',
      reviewFeedback: 'Missing input validation on line 42',
      reworkCycle: 1,
      projectId: 'proj',
      originalTitle: 'Add endpoint',
    });
    const call = bb._items[0];
    expect(call.description).toContain('Missing input validation on line 42');
    expect(call.description).toContain('PR #7');
    expect(call.description).toContain('fix/5');
  });

  test('cycle within default limit allowed, above escalates', () => {
    const bb = createMockBb();
    const opts = {
      prNumber: 1, prUrl: '', repo: 'o/r', branch: 'b',
      implementationWorkItemId: 'x', reviewFeedback: 'f',
      projectId: 'p', originalTitle: 't',
    };
    // DEFAULT_MAX_REWORK_CYCLES (2) is fallback — cycle 2 allowed, cycle 3 escalates
    expect(createReworkWorkItem(bb as any, { ...opts, reworkCycle: 2 })).not.toBeNull();
    expect(createReworkWorkItem(bb as any, { ...opts, reworkCycle: 3 })).toBeNull();
    // Hard limit (MAX_REWORK_CYCLES=3) blocks cycle 4 regardless
    expect(createReworkWorkItem(bb as any, { ...opts, reworkCycle: 4 })).toBeNull();
  });
});

describe('buildReworkPrompt', () => {
  test('includes PR number and repo', () => {
    const prompt = buildReworkPrompt({
      rework: true,
      pr_number: 42,
      pr_url: 'https://github.com/o/r/pull/42',
      repo: 'owner/repo',
      branch: 'fix/10',
      implementation_work_item_id: 'x',
      review_feedback: 'Fix the bug on line 5',
      rework_cycle: 1,
      project_id: 'p',
    });
    expect(prompt).toContain('PR #42');
    expect(prompt).toContain('owner/repo');
    expect(prompt).toContain('Fix the bug on line 5');
    expect(prompt).toContain('cycle 1/3');
  });

  test('includes gh CLI commands for fetching review comments', () => {
    const prompt = buildReworkPrompt({
      rework: true,
      pr_number: 10,
      pr_url: '',
      repo: 'o/r',
      branch: 'b',
      implementation_work_item_id: 'x',
      review_feedback: 'feedback',
      rework_cycle: 2,
      project_id: 'p',
    });
    expect(prompt).toContain('gh pr view 10');
    expect(prompt).toContain('gh api repos/o/r/pulls/10/comments');
  });
});

describe('MAX_REWORK_CYCLES', () => {
  test('is set to 3', () => {
    expect(MAX_REWORK_CYCLES).toBe(3);
  });
});

describe('DEFAULT_MAX_REWORK_CYCLES', () => {
  test('is set to 2', () => {
    expect(DEFAULT_MAX_REWORK_CYCLES).toBe(2);
  });
});

describe('resolveMaxReworkCycles', () => {
  test('uses project metadata max_rework_cycles when available', () => {
    const bb = createFullMockBb({ max_rework_cycles: 1 });
    expect(resolveMaxReworkCycles(bb as any, 'test-proj')).toBe(1);
  });

  test('caps project metadata at MAX_REWORK_CYCLES', () => {
    const bb = createFullMockBb({ max_rework_cycles: 10 });
    expect(resolveMaxReworkCycles(bb as any, 'test-proj')).toBe(MAX_REWORK_CYCLES);
  });

  test('uses metaMaxCycles when project has no config', () => {
    const bb = createFullMockBb({});
    expect(resolveMaxReworkCycles(bb as any, 'test-proj', 2)).toBe(2);
  });

  test('falls back to DEFAULT_MAX_REWORK_CYCLES when no config at all', () => {
    const bb = createMockBb();
    expect(resolveMaxReworkCycles(bb as any, 'test-proj')).toBe(DEFAULT_MAX_REWORK_CYCLES);
  });
});

describe('idempotency', () => {
  test('returns existing item ID if duplicate rework for same PR/cycle', () => {
    const bb = createMockBb();
    const existingItem = {
      item_id: 'rework-p-pr-42-cycle-1',
      metadata: JSON.stringify({
        rework: true,
        pr_number: 42,
        repo: 'o/r',
        branch: 'b',
        rework_cycle: 1,
      }),
    };
    bb.listWorkItems = mock(() => [existingItem] as any);

    const id = createReworkWorkItem(bb as any, {
      prNumber: 42,
      prUrl: '',
      repo: 'o/r',
      branch: 'b',
      implementationWorkItemId: 'x',
      reviewFeedback: 'fix',
      reworkCycle: 1,
      projectId: 'p',
      originalTitle: 'Fix bug',
    });

    expect(id).toBe('rework-p-pr-42-cycle-1');
    expect(bb.createWorkItem).not.toHaveBeenCalled();
  });

  test('creates new item when no duplicate exists', () => {
    const bb = createMockBb();
    bb.listWorkItems = mock(() => [] as any);

    const id = createReworkWorkItem(bb as any, {
      prNumber: 42,
      prUrl: '',
      repo: 'o/r',
      branch: 'b',
      implementationWorkItemId: 'x',
      reviewFeedback: 'fix',
      reworkCycle: 1,
      projectId: 'p',
      originalTitle: 'Fix bug',
    });

    expect(id).toBe('rework-p-pr-42-cycle-1');
    expect(bb.createWorkItem).toHaveBeenCalledTimes(1);
  });
});

describe('escalation', () => {
  test('sets human_review_required when configurable max exceeded', () => {
    const bb = createFullMockBb({ max_rework_cycles: 2 });

    const id = createReworkWorkItem(bb as any, {
      prNumber: 42,
      prUrl: '',
      repo: 'o/r',
      branch: 'b',
      implementationWorkItemId: 'impl-1',
      reviewFeedback: 'fix',
      reworkCycle: 3,
      projectId: 'test-proj',
      originalTitle: 'Fix bug',
      sessionId: 'sess-1',
    });

    expect(id).toBeNull();
    expect(bb.updateWorkItemMetadata).toHaveBeenCalledTimes(1);
    expect(bb._updatedMetadata[0].itemId).toBe('impl-1');
    expect(bb._updatedMetadata[0].updates.human_review_required).toBe(true);
    expect(bb._updatedMetadata[0].updates.escalation_reason).toContain('Max rework cycles (2) exceeded');
  });

  test('emits escalation event with human_escalation type', () => {
    const bb = createFullMockBb({ max_rework_cycles: 1 });

    createReworkWorkItem(bb as any, {
      prNumber: 42,
      prUrl: '',
      repo: 'o/r',
      branch: 'b',
      implementationWorkItemId: 'impl-1',
      reviewFeedback: 'fix',
      reworkCycle: 2,
      projectId: 'test-proj',
      originalTitle: 'Fix bug',
      sessionId: 'sess-1',
    });

    expect(bb._events.length).toBeGreaterThan(0);
    const escalationEvent = bb._events.find((e: any) => e.metadata?.eventType === 'human_escalation');
    expect(escalationEvent).toBeDefined();
    expect(escalationEvent.summary).toContain('escalating to human review');
  });
});

describe('parseReworkMeta (extended fields)', () => {
  test('parses worktree_path when present', () => {
    const meta = {
      rework: true,
      pr_number: 42,
      repo: 'o/r',
      branch: 'fix/1',
      worktree_path: '/tmp/worktrees/proj/fix-1',
    };
    const result = parseReworkMeta(JSON.stringify(meta));
    expect(result!.worktree_path).toBe('/tmp/worktrees/proj/fix-1');
  });

  test('parses inline_comments when present', () => {
    const meta = {
      rework: true,
      pr_number: 42,
      repo: 'o/r',
      branch: 'fix/1',
      inline_comments: [
        { path: 'src/a.ts', line: 10, body: 'Fix this', author: 'reviewer', created_at: '2026-01-15' },
      ],
    };
    const result = parseReworkMeta(JSON.stringify(meta));
    expect(result!.inline_comments).toHaveLength(1);
    expect(result!.inline_comments![0].path).toBe('src/a.ts');
  });

  test('parses max_rework_cycles when present', () => {
    const meta = {
      rework: true,
      pr_number: 42,
      repo: 'o/r',
      branch: 'fix/1',
      max_rework_cycles: 2,
    };
    const result = parseReworkMeta(JSON.stringify(meta));
    expect(result!.max_rework_cycles).toBe(2);
  });
});

describe('buildReworkPrompt (inline comments)', () => {
  test('includes file-level comments section when inline_comments provided', () => {
    const prompt = buildReworkPrompt({
      rework: true,
      pr_number: 42,
      pr_url: '',
      repo: 'o/r',
      branch: 'fix/1',
      implementation_work_item_id: 'x',
      review_feedback: 'Please fix',
      rework_cycle: 1,
      project_id: 'p',
      inline_comments: [
        { path: 'src/auth.ts', line: 42, body: 'Needs validation', author: 'alice', created_at: '2026-01-15' },
        { path: 'src/db.ts', line: 10, body: 'Use params', author: 'bob', created_at: '2026-01-15' },
      ],
    });
    expect(prompt).toContain('## File-Level Comments');
    expect(prompt).toContain('### src/auth.ts:42');
    expect(prompt).toContain('> Needs validation');
    expect(prompt).toContain('— @alice');
    expect(prompt).toContain('### src/db.ts:10');
    expect(prompt).toContain('> Use params');
    expect(prompt).toContain('— @bob');
  });

  test('omits file-level comments section when no inline_comments', () => {
    const prompt = buildReworkPrompt({
      rework: true,
      pr_number: 42,
      pr_url: '',
      repo: 'o/r',
      branch: 'fix/1',
      implementation_work_item_id: 'x',
      review_feedback: 'feedback',
      rework_cycle: 1,
      project_id: 'p',
    });
    expect(prompt).not.toContain('## File-Level Comments');
  });

  test('includes worktree_path and inline_comments in metadata', () => {
    const bb = createMockBb();
    createReworkWorkItem(bb as any, {
      prNumber: 42,
      prUrl: '',
      repo: 'o/r',
      branch: 'b',
      implementationWorkItemId: 'x',
      reviewFeedback: 'fix',
      reworkCycle: 1,
      projectId: 'p',
      originalTitle: 'Fix bug',
      worktreePath: '/tmp/wt/proj/b',
      inlineComments: [
        { path: 'src/a.ts', line: 5, body: 'Fix', author: 'r', created_at: '2026-01-15' },
      ],
    });

    const storedMeta = JSON.parse(bb._items[0].metadata);
    expect(storedMeta.worktree_path).toBe('/tmp/wt/proj/b');
    expect(storedMeta.inline_comments).toHaveLength(1);
    expect(storedMeta.inline_comments[0].path).toBe('src/a.ts');
  });
});
