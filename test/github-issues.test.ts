import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Blackboard } from '../src/blackboard.ts';
import {
  parseGithubIssuesConfig,
  extractOwnerRepo,
  evaluateGithubIssues,
  setIssueFetcher,
  resetIssueFetcher,
  setBlackboardAccessor,
  resetBlackboardAccessor,
  type GithubIssue,
} from '../src/evaluators/github-issues.ts';
import type { ChecklistItem } from '../src/parser/types.ts';
import { registerProject } from 'ivy-blackboard/src/project';

function makeItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    name: 'GitHub Issues',
    type: 'github_issues',
    severity: 'medium',
    channels: ['terminal'],
    enabled: true,
    description: 'Check for new GitHub issues',
    config: {},
    ...overrides,
  };
}

function makeIssue(overrides: Partial<GithubIssue> = {}): GithubIssue {
  return {
    number: 1,
    title: 'Bug: something broken',
    url: 'https://github.com/owner/repo/issues/1',
    state: 'open',
    labels: [],
    createdAt: new Date().toISOString(),
    author: { login: 'reporter' },
    ...overrides,
  };
}

describe('parseGithubIssuesConfig', () => {
  test('returns defaults for empty config', () => {
    const config = parseGithubIssuesConfig(makeItem());
    expect(config.labels).toEqual([]);
    expect(config.limit).toBe(30);
  });

  test('respects custom labels and limit', () => {
    const config = parseGithubIssuesConfig(
      makeItem({ config: { labels: ['bug', 'critical'], limit: 10 } })
    );
    expect(config.labels).toEqual(['bug', 'critical']);
    expect(config.limit).toBe(10);
  });
});

describe('extractOwnerRepo', () => {
  test('extracts from https URL', () => {
    expect(extractOwnerRepo('https://github.com/jcfischer/supertag-cli')).toBe('jcfischer/supertag-cli');
  });

  test('extracts from .git URL', () => {
    expect(extractOwnerRepo('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  test('extracts from SSH URL', () => {
    expect(extractOwnerRepo('git@github.com:owner/repo')).toBe('owner/repo');
  });

  test('returns null for non-GitHub URL', () => {
    expect(extractOwnerRepo('https://gitlab.com/owner/repo')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(extractOwnerRepo('')).toBeNull();
  });
});

describe('evaluateGithubIssues', () => {
  let bb: Blackboard;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hb-ghissues-'));
    bb = new Blackboard(join(tmpDir, 'test.db'));

    // Register a project with a GitHub repo
    registerProject(bb.db, {
      id: 'test-project',
      name: 'Test Project',
      path: '/tmp/test-project',
      repo: 'https://github.com/owner/test-project',
    });

    setBlackboardAccessor(bb);
  });

  afterEach(() => {
    resetIssueFetcher();
    resetBlackboardAccessor();
    bb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns error when blackboard accessor not set', async () => {
    resetBlackboardAccessor();
    const result = await evaluateGithubIssues(makeItem());
    expect(result.status).toBe('error');
    expect(result.summary).toContain('blackboard not configured');
  });

  test('returns ok when no GitHub projects registered', async () => {
    // Use a fresh blackboard with no projects
    const tmpDir2 = mkdtempSync(join(tmpdir(), 'hb-ghissues-empty-'));
    const bb2 = new Blackboard(join(tmpDir2, 'test.db'));
    setBlackboardAccessor(bb2);

    const result = await evaluateGithubIssues(makeItem());
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('no projects with GitHub repos');

    bb2.close();
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  test('returns ok when no new issues', async () => {
    setIssueFetcher(async () => []);
    const result = await evaluateGithubIssues(makeItem());
    expect(result.status).toBe('ok');
    expect(result.details?.newIssues).toBe(0);
  });

  test('returns alert and creates work items for new issues', async () => {
    const issues = [
      makeIssue({ number: 1, title: 'Bug A', url: 'https://github.com/owner/test-project/issues/1' }),
      makeIssue({ number: 2, title: 'Bug B', url: 'https://github.com/owner/test-project/issues/2' }),
    ];
    setIssueFetcher(async () => issues);

    const result = await evaluateGithubIssues(makeItem());
    expect(result.status).toBe('alert');
    expect(result.details?.newIssues).toBe(2);

    // Verify work items were created
    const workItems = bb.listWorkItems({ all: true, project: 'test-project' });
    expect(workItems.length).toBe(2);
    expect(workItems[0].source).toBe('github');
    expect(workItems[0].source_ref).toContain('github.com');
  });

  test('skips issues already tracked as work items', async () => {
    // Create a work item for issue #1 first
    bb.createWorkItem({
      id: 'gh-test-project-1',
      title: 'Issue #1: Old bug',
      project: 'test-project',
      source: 'github',
      sourceRef: 'https://github.com/owner/test-project/issues/1',
    });

    const issues = [
      makeIssue({ number: 1, title: 'Old bug', url: 'https://github.com/owner/test-project/issues/1' }),
      makeIssue({ number: 2, title: 'New bug', url: 'https://github.com/owner/test-project/issues/2' }),
    ];
    setIssueFetcher(async () => issues);

    const result = await evaluateGithubIssues(makeItem());
    expect(result.status).toBe('alert');
    expect(result.details?.newIssues).toBe(1);

    const workItems = bb.listWorkItems({ all: true, project: 'test-project' });
    expect(workItems.length).toBe(2); // 1 pre-existing + 1 new
  });

  test('work item metadata includes human review workflow', async () => {
    const issues = [
      makeIssue({ number: 5, title: 'Fix needed', url: 'https://github.com/owner/test-project/issues/5' }),
    ];
    setIssueFetcher(async () => issues);

    await evaluateGithubIssues(makeItem());

    const workItems = bb.listWorkItems({ all: true, project: 'test-project' });
    expect(workItems.length).toBe(1);

    const metadata = JSON.parse(workItems[0].metadata!);
    expect(metadata.human_review_required).toBe(true);
    expect(metadata.auto_push).toBe(false);
    expect(metadata.workflow).toBe('acknowledge-investigate-fix-notify-review');
    expect(metadata.github_issue_number).toBe(5);
    expect(metadata.github_repo).toBe('owner/test-project');
  });

  test('work item description includes fix workflow steps', async () => {
    const issues = [
      makeIssue({
        number: 3,
        title: 'Auth broken',
        url: 'https://github.com/owner/test-project/issues/3',
        labels: [{ name: 'bug' }, { name: 'critical' }],
        author: { login: 'alice' },
      }),
    ];
    setIssueFetcher(async () => issues);

    await evaluateGithubIssues(makeItem());

    const workItems = bb.listWorkItems({ all: true, project: 'test-project' });
    const desc = workItems[0].description!;
    expect(desc).toContain('GitHub Issue #3: Auth broken');
    expect(desc).toContain('Opened by: alice');
    expect(desc).toContain('Labels: bug, critical');
    expect(desc).toContain('Acknowledge');
    expect(desc).toContain('Investigate');
    expect(desc).toContain('Human review');
    expect(desc).toContain('do NOT push');
  });

  test('work item priority is P2 by default', async () => {
    const issues = [
      makeIssue({ number: 10, url: 'https://github.com/owner/test-project/issues/10' }),
    ];
    setIssueFetcher(async () => issues);

    await evaluateGithubIssues(makeItem());

    const workItems = bb.listWorkItems({ all: true, project: 'test-project' });
    expect(workItems[0].priority).toBe('P2');
  });

  test('handles fetcher errors gracefully', async () => {
    setIssueFetcher(async () => { throw new Error('Network timeout'); });

    const result = await evaluateGithubIssues(makeItem());
    expect(result.status).toBe('error');
    expect(result.summary).toContain('Network timeout');
  });

  test('skips projects without GitHub remote_repo', async () => {
    // Register a project without GitHub
    registerProject(bb.db, {
      id: 'local-only',
      name: 'Local Only',
      path: '/tmp/local',
    });

    setIssueFetcher(async () => [makeIssue()]);

    const result = await evaluateGithubIssues(makeItem());
    // Should only check test-project (has GitHub), not local-only
    expect(result.details?.projectsChecked).toBe(1);
  });
});
