import { describe, test, expect, afterEach } from 'bun:test';
import {
  evaluateEmail,
  parseEmailConfig,
  setImapCounter,
  resetImapCounter,
} from '../src/evaluators/email.ts';
import type { ChecklistItem } from '../src/parser/types.ts';

function makeItem(config: Record<string, unknown> = {}): ChecklistItem {
  return {
    name: 'Email Backlog',
    type: 'email',
    severity: 'medium',
    channels: ['terminal'],
    enabled: true,
    description: 'Check email backlog',
    config,
  };
}

describe('parseEmailConfig', () => {
  const origHost = process.env.IMAP_HOST;
  const origUser = process.env.IMAP_USER;
  const origPass = process.env.IMAP_PASS;

  afterEach(() => {
    // Restore env
    if (origHost) process.env.IMAP_HOST = origHost; else delete process.env.IMAP_HOST;
    if (origUser) process.env.IMAP_USER = origUser; else delete process.env.IMAP_USER;
    if (origPass) process.env.IMAP_PASS = origPass; else delete process.env.IMAP_PASS;
  });

  test('returns null when IMAP not configured', () => {
    delete process.env.IMAP_HOST;
    delete process.env.IMAP_USER;
    delete process.env.IMAP_PASS;
    const config = parseEmailConfig(makeItem());
    expect(config).toBeNull();
  });

  test('uses env vars for IMAP config', () => {
    process.env.IMAP_HOST = 'imap.example.com';
    process.env.IMAP_USER = 'user@example.com';
    process.env.IMAP_PASS = 'secret';
    const config = parseEmailConfig(makeItem());
    expect(config).not.toBeNull();
    expect(config!.imapHost).toBe('imap.example.com');
    expect(config!.imapUser).toBe('user@example.com');
  });

  test('item config overrides env vars for host/user', () => {
    process.env.IMAP_HOST = 'env-host';
    process.env.IMAP_USER = 'env-user';
    process.env.IMAP_PASS = 'secret';
    const config = parseEmailConfig(makeItem({
      imap_host: 'config-host',
      imap_user: 'config-user',
    }));
    expect(config!.imapHost).toBe('config-host');
    expect(config!.imapUser).toBe('config-user');
  });

  test('uses defaults for optional fields', () => {
    process.env.IMAP_HOST = 'host';
    process.env.IMAP_USER = 'user';
    process.env.IMAP_PASS = 'pass';
    const config = parseEmailConfig(makeItem());
    expect(config!.imapPort).toBe(993);
    expect(config!.maxUnread).toBe(10);
    expect(config!.maxAgeHours).toBe(48);
    expect(config!.fromFilter).toEqual([]);
  });

  test('parses from_filter as comma-separated list', () => {
    process.env.IMAP_HOST = 'host';
    process.env.IMAP_USER = 'user';
    process.env.IMAP_PASS = 'pass';
    const config = parseEmailConfig(makeItem({ from_filter: 'boss@co.com, team@co.com' }));
    expect(config!.fromFilter).toEqual(['boss@co.com', 'team@co.com']);
  });
});

describe('evaluateEmail', () => {
  afterEach(() => {
    resetImapCounter();
  });

  test('returns ok with skip message when IMAP not configured', async () => {
    delete process.env.IMAP_HOST;
    delete process.env.IMAP_USER;
    delete process.env.IMAP_PASS;

    const result = await evaluateEmail(makeItem());
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('not configured');
  });

  test('returns alert when unread exceeds threshold', async () => {
    process.env.IMAP_HOST = 'host';
    process.env.IMAP_USER = 'user';
    process.env.IMAP_PASS = 'pass';

    setImapCounter(async () => 15);

    const result = await evaluateEmail(makeItem({ max_unread: 10 }));
    expect(result.status).toBe('alert');
    expect(result.summary).toContain('15 unread');
    expect(result.summary).toContain('threshold: 10');
  });

  test('returns ok when unread within threshold', async () => {
    process.env.IMAP_HOST = 'host';
    process.env.IMAP_USER = 'user';
    process.env.IMAP_PASS = 'pass';

    setImapCounter(async () => 3);

    const result = await evaluateEmail(makeItem({ max_unread: 10 }));
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('3 unread');
    expect(result.summary).toContain('within threshold');
  });

  test('returns ok when unread exactly at threshold', async () => {
    process.env.IMAP_HOST = 'host';
    process.env.IMAP_USER = 'user';
    process.env.IMAP_PASS = 'pass';

    setImapCounter(async () => 10);

    const result = await evaluateEmail(makeItem({ max_unread: 10 }));
    expect(result.status).toBe('ok');
  });

  test('returns error when IMAP counter throws', async () => {
    process.env.IMAP_HOST = 'host';
    process.env.IMAP_USER = 'user';
    process.env.IMAP_PASS = 'pass';

    setImapCounter(async () => { throw new Error('Connection refused'); });

    const result = await evaluateEmail(makeItem());
    expect(result.status).toBe('error');
    expect(result.summary).toContain('IMAP error');
    expect(result.summary).toContain('Connection refused');
  });

  test('zero unread returns ok', async () => {
    process.env.IMAP_HOST = 'host';
    process.env.IMAP_USER = 'user';
    process.env.IMAP_PASS = 'pass';

    setImapCounter(async () => 0);

    const result = await evaluateEmail(makeItem());
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('0 unread');
  });
});
