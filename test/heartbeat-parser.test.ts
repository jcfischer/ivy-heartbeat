import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseHeartbeatChecklist, parseContent } from '../src/parser/heartbeat-parser.ts';
import type { ChecklistItem } from '../src/parser/types.ts';

// ─── Test Content ───────────────────────────────────────────────────────────

const VALID_CHECKLIST = `# Ivy Heartbeat Checklist

## Calendar Conflicts
\`\`\`yaml
type: calendar
severity: medium
channels: [voice, terminal]
enabled: true
description: Check for overlapping meetings in the next 24 hours
\`\`\`

## Important Emails
\`\`\`yaml
type: email
severity: low
channels: [terminal]
enabled: true
description: Check for emails from VIP senders
senders:
  - boss@company.com
  - client@important.org
\`\`\`

## Custom Check
\`\`\`yaml
type: custom
severity: high
channels: [voice, terminal, email]
enabled: true
description: Run custom script to check system health
command: ~/.pai/checks/health.sh
\`\`\`
`;

const MIXED_VALID_INVALID = `# Checklist

## Valid Item
\`\`\`yaml
type: calendar
severity: medium
channels: [terminal]
enabled: true
description: A valid item
\`\`\`

## Invalid Item
\`\`\`yaml
type: unknown_type
severity: medium
description: This has an invalid type
\`\`\`

## Another Valid Item
\`\`\`yaml
type: custom
severity: high
channels: [voice]
enabled: false
description: Another valid item
command: /usr/bin/check
\`\`\`
`;

const DEFAULTS_CHECKLIST = `# Defaults Test

## Minimal Item
\`\`\`yaml
type: calendar
description: Only required fields provided
\`\`\`
`;

const NO_YAML_BLOCKS = `# Just a heading

## Section without yaml

Some plain text here, no yaml block.

## Another section

More text.
`;

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('parseContent', () => {
  test('parses valid 3-item checklist', () => {
    const items = parseContent(VALID_CHECKLIST);
    expect(items.length).toBe(3);
  });

  test('first item has correct fields', () => {
    const items = parseContent(VALID_CHECKLIST);
    const cal = items[0]!;
    expect(cal.name).toBe('Calendar Conflicts');
    expect(cal.type).toBe('calendar');
    expect(cal.severity).toBe('medium');
    expect(cal.channels).toEqual(['voice', 'terminal']);
    expect(cal.enabled).toBe(true);
    expect(cal.description).toBe('Check for overlapping meetings in the next 24 hours');
  });

  test('email item captures senders in config', () => {
    const items = parseContent(VALID_CHECKLIST);
    const email = items[1]!;
    expect(email.type).toBe('email');
    expect(email.config).toHaveProperty('senders');
    expect((email.config as any).senders).toEqual(['boss@company.com', 'client@important.org']);
  });

  test('custom item captures command in config', () => {
    const items = parseContent(VALID_CHECKLIST);
    const custom = items[2]!;
    expect(custom.type).toBe('custom');
    expect(custom.config).toHaveProperty('command');
    expect((custom.config as any).command).toBe('~/.pai/checks/health.sh');
  });

  test('skips invalid items, keeps valid ones', () => {
    const items = parseContent(MIXED_VALID_INVALID);
    expect(items.length).toBe(2);
    expect(items[0]!.name).toBe('Valid Item');
    expect(items[1]!.name).toBe('Another Valid Item');
  });

  test('disabled items are included with enabled=false', () => {
    const items = parseContent(MIXED_VALID_INVALID);
    const disabled = items.find((i) => i.name === 'Another Valid Item');
    expect(disabled).not.toBeUndefined();
    expect(disabled!.enabled).toBe(false);
  });

  test('applies default values for missing optional fields', () => {
    const items = parseContent(DEFAULTS_CHECKLIST);
    expect(items.length).toBe(1);
    const item = items[0]!;
    expect(item.severity).toBe('medium');
    expect(item.channels).toEqual(['terminal']);
    expect(item.enabled).toBe(true);
  });

  test('returns empty array for content with no yaml blocks', () => {
    const items = parseContent(NO_YAML_BLOCKS);
    expect(items.length).toBe(0);
  });

  test('returns empty array for empty string', () => {
    const items = parseContent('');
    expect(items.length).toBe(0);
  });
});

describe('parseHeartbeatChecklist (file-based)', () => {
  test('returns empty array for missing file', () => {
    const items = parseHeartbeatChecklist('/nonexistent/path/IVY_HEARTBEAT.md');
    expect(items).toEqual([]);
  });

  test('parses file from custom path', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hb-parser-'));
    const filePath = join(tmpDir, 'IVY_HEARTBEAT.md');
    writeFileSync(filePath, VALID_CHECKLIST, 'utf-8');

    const items = parseHeartbeatChecklist(filePath);
    expect(items.length).toBe(3);
    expect(items[0]!.name).toBe('Calendar Conflicts');

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('parses empty file gracefully', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hb-parser-'));
    const filePath = join(tmpDir, 'EMPTY.md');
    writeFileSync(filePath, '', 'utf-8');

    const items = parseHeartbeatChecklist(filePath);
    expect(items).toEqual([]);

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
