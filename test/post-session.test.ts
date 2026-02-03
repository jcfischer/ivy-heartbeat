import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseTranscript, extractSessionSummary } from '../src/hooks/transcript.ts';
import { extractFacts } from '../src/hooks/extractor.ts';
import { Blackboard } from '../src/blackboard.ts';

// ── Transcript parsing ──────────────────────────────────────────────────

describe('parseTranscript', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hb-hook-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('parses valid JSONL lines', () => {
    const jsonlPath = join(tmpDir, 'session.jsonl');
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'message', role: 'user', content: 'Hello' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Hi there' }),
    ].join('\n'));

    const messages = parseTranscript(jsonlPath);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
  });

  test('skips malformed lines', () => {
    const jsonlPath = join(tmpDir, 'bad.jsonl');
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'message', role: 'user', content: 'Hello' }),
      'not valid json {{{',
      JSON.stringify({ type: 'message', role: 'assistant', content: 'World' }),
    ].join('\n'));

    const messages = parseTranscript(jsonlPath);
    expect(messages).toHaveLength(2);
  });

  test('handles empty file', () => {
    const jsonlPath = join(tmpDir, 'empty.jsonl');
    writeFileSync(jsonlPath, '');

    const messages = parseTranscript(jsonlPath);
    expect(messages).toHaveLength(0);
  });
});

// ── Session summary extraction ──────────────────────────────────────────

describe('extractSessionSummary', () => {
  test('extracts session ID from filename', () => {
    const messages = [
      { type: 'message', role: 'user', content: 'Hello', timestamp: '2026-02-03T10:00:00Z' },
    ];
    const summary = extractSessionSummary(messages, '/tmp/projects/-Users-test-project/abc123.jsonl');
    expect(summary.sessionId).toBe('abc123');
  });

  test('extracts project path from directory', () => {
    const messages = [
      { type: 'message', role: 'user', content: 'Hello', timestamp: '2026-02-03T10:00:00Z' },
    ];
    const summary = extractSessionSummary(messages, '/tmp/projects/-Users-test-myproject/session.jsonl');
    expect(summary.projectPath).toContain('Users/test/myproject');
  });

  test('calculates duration from timestamps', () => {
    const messages = [
      { type: 'message', role: 'user', content: 'Hello', timestamp: '2026-02-03T10:00:00Z' },
      { type: 'message', role: 'assistant', content: 'Hi', timestamp: '2026-02-03T10:30:00Z' },
    ];
    const summary = extractSessionSummary(messages, '/tmp/test/session.jsonl');
    expect(summary.durationMinutes).toBe(30);
  });

  test('extracts tools from tool_use messages', () => {
    const messages = [
      { type: 'message', tool_use: { name: 'Read', input: { file_path: '/tmp/test.ts' } } },
      { type: 'message', tool_use: { name: 'Write', input: { file_path: '/tmp/out.ts' } } },
      { type: 'message', tool_use: { name: 'Read', input: { file_path: '/tmp/other.ts' } } },
    ];
    const summary = extractSessionSummary(messages, '/tmp/test/session.jsonl');
    expect(summary.toolsUsed).toContain('Read');
    expect(summary.toolsUsed).toContain('Write');
    expect(summary.toolsUsed).toHaveLength(2); // Deduplicated
  });

  test('extracts files from tool inputs', () => {
    const messages = [
      { type: 'message', tool_use: { name: 'Write', input: { file_path: '/src/index.ts' } } },
      { type: 'message', tool_use: { name: 'Read', input: { file_path: '/src/util.ts' } } },
    ];
    const summary = extractSessionSummary(messages, '/tmp/test/session.jsonl');
    expect(summary.filesModified).toContain('/src/index.ts');
    expect(summary.filesModified).toContain('/src/util.ts');
  });

  test('extracts assistant text messages', () => {
    const messages = [
      { type: 'message', role: 'assistant', content: 'Here is the fix' },
      { type: 'message', role: 'user', content: 'Thanks' },
      { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Done implementing' }] },
    ];
    const summary = extractSessionSummary(messages, '/tmp/test/session.jsonl');
    expect(summary.assistantMessages).toContain('Here is the fix');
    expect(summary.assistantMessages).toContain('Done implementing');
    expect(summary.assistantMessages).toHaveLength(2);
  });
});

// ── Fact extraction ─────────────────────────────────────────────────────

describe('extractFacts', () => {
  test('extracts "decided to" facts', () => {
    const facts = extractFacts(['We decided to use SQLite instead of PostgreSQL for local storage']);
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0].type).toBe('fact');
    expect(facts[0].text).toContain('use SQLite');
  });

  test('extracts "root cause" facts', () => {
    const facts = extractFacts(['The root cause was a missing null check in the parser']);
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0].type).toBe('fact');
  });

  test('extracts pattern indicators', () => {
    const facts = extractFacts(['This project uses Commander.js for all CLI commands']);
    const patterns = facts.filter((f) => f.type === 'pattern');
    expect(patterns.length).toBeGreaterThanOrEqual(1);
  });

  test('deduplicates identical facts', () => {
    const facts = extractFacts([
      'We decided to use TypeScript for everything',
      'Earlier we decided to use TypeScript for everything',
    ]);
    const unique = facts.filter((f) => f.text.includes('use TypeScript'));
    expect(unique.length).toBe(1);
  });

  test('returns empty for no matching patterns', () => {
    const facts = extractFacts(['Hello world. This is a normal message. Nothing special.']);
    expect(facts).toHaveLength(0);
  });

  test('extracts key insight facts', () => {
    const facts = extractFacts(['Key insight: FTS5 needs content-sync mode for external tables']);
    expect(facts.length).toBeGreaterThanOrEqual(1);
    expect(facts[0].text).toContain('FTS5');
  });
});

// ── Integration: hook writes events ─────────────────────────────────────

describe('post-session hook integration', () => {
  let bb: Blackboard;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hb-hook-int-'));
    bb = new Blackboard(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    bb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('full pipeline: parse → extract → record events', () => {
    // Create a mock transcript
    const jsonlPath = join(tmpDir, 'session-abc.jsonl');
    writeFileSync(jsonlPath, [
      JSON.stringify({ type: 'message', role: 'user', content: 'Fix the bug', timestamp: '2026-02-03T10:00:00Z' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'The root cause was a missing return statement. We decided to add early returns for all error paths.', timestamp: '2026-02-03T10:05:00Z' }),
      JSON.stringify({ type: 'message', tool_use: { name: 'Edit', input: { file_path: '/src/fix.ts' } }, timestamp: '2026-02-03T10:06:00Z' }),
      JSON.stringify({ type: 'message', role: 'assistant', content: 'Done. This project uses TDD so I wrote tests first.', timestamp: '2026-02-03T10:10:00Z' }),
    ].join('\n'));

    const messages = parseTranscript(jsonlPath);
    const summary = extractSessionSummary(messages, jsonlPath);
    const facts = extractFacts(summary.assistantMessages);

    // Record events
    bb.appendEvent({
      summary: `Session started: ${summary.projectPath}`,
      metadata: { hookEvent: 'session_started', sessionId: summary.sessionId },
    });

    bb.appendEvent({
      summary: `Session activity: ${summary.messageCount} messages`,
      metadata: { hookEvent: 'session_activity', sessionId: summary.sessionId, toolsUsed: summary.toolsUsed },
    });

    for (const fact of facts) {
      bb.appendEvent({
        summary: `${fact.type === 'fact' ? 'Fact extracted' : 'Pattern detected'}: ${fact.text}`,
        metadata: { hookEvent: fact.type === 'fact' ? 'fact_extracted' : 'pattern_detected', text: fact.text },
      });
    }

    bb.appendEvent({
      summary: `Session ended: ${summary.projectPath}`,
      metadata: { hookEvent: 'session_ended', sessionId: summary.sessionId },
    });

    // Verify events
    const events = bb.eventQueries.getRecent(20);
    const hookEvents = events.filter((e) => e.metadata?.includes('"hookEvent"'));
    expect(hookEvents.length).toBeGreaterThanOrEqual(4); // start + activity + end + at least 1 fact

    // Session events recorded
    expect(hookEvents.some((e) => e.metadata?.includes('"session_started"'))).toBe(true);
    expect(hookEvents.some((e) => e.metadata?.includes('"session_ended"'))).toBe(true);
    expect(hookEvents.some((e) => e.metadata?.includes('"session_activity"'))).toBe(true);

    // Facts extracted
    expect(facts.length).toBeGreaterThanOrEqual(1);
  });
});
