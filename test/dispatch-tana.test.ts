import { describe, test, expect } from 'bun:test';
import { parseTanaMeta } from '../src/commands/dispatch-worker.ts';

describe('parseTanaMeta', () => {
  test('returns isTana: false for null metadata', () => {
    const result = parseTanaMeta(null);
    expect(result.isTana).toBe(false);
  });

  test('returns isTana: false for non-Tana metadata (GitHub)', () => {
    const result = parseTanaMeta(JSON.stringify({
      github_issue_number: 42,
      github_repo: 'owner/repo',
    }));
    expect(result.isTana).toBe(false);
  });

  test('returns isTana: true for valid Tana metadata', () => {
    const result = parseTanaMeta(JSON.stringify({
      tana_node_id: 'node-abc123',
      tana_workspace_id: 'ws-1',
      tana_tag_id: 'tag-xyz',
    }));
    expect(result.isTana).toBe(true);
    expect(result.nodeId).toBe('node-abc123');
    expect(result.workspaceId).toBe('ws-1');
    expect(result.tagId).toBe('tag-xyz');
  });

  test('returns isTana: false for malformed JSON', () => {
    const result = parseTanaMeta('not valid json{{{');
    expect(result.isTana).toBe(false);
  });

  test('returns isTana: false for empty object', () => {
    const result = parseTanaMeta(JSON.stringify({}));
    expect(result.isTana).toBe(false);
  });

  test('returns isTana: true with only tana_node_id (minimal metadata)', () => {
    const result = parseTanaMeta(JSON.stringify({
      tana_node_id: 'node-minimal',
    }));
    expect(result.isTana).toBe(true);
    expect(result.nodeId).toBe('node-minimal');
    expect(result.workspaceId).toBeUndefined();
    expect(result.tagId).toBeUndefined();
  });

  test('returns isTana: false for empty string', () => {
    const result = parseTanaMeta('');
    expect(result.isTana).toBe(false);
  });
});
