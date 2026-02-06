import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Blackboard } from '../src/blackboard.ts';
import { logCredentialAccess, logCredentialDenied } from '../src/credential/audit.ts';
import { loadScopeConfig, isCredentialAllowed } from '../src/credential/scope.ts';
import type { CredentialScopeConfig } from '../src/credential/types.ts';

describe('credential audit logging', () => {
  let bb: Blackboard;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hb-cred-'));
    const dbPath = join(tmpDir, 'test.db');
    bb = new Blackboard(dbPath);
  });

  afterEach(() => {
    bb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('logCredentialAccess records event with correct metadata', () => {
    logCredentialAccess(bb, {
      skill: 'email',
      credentialType: 'smtp_password',
    });

    const events = bb.eventQueries.getRecent(5);
    const credEvent = events.find((e) => e.summary.includes('Credential accessed'));
    expect(credEvent).toBeDefined();
    expect(credEvent!.summary).toContain('smtp_password');
    expect(credEvent!.summary).toContain('email');

    const meta = JSON.parse(credEvent!.metadata!);
    expect(meta.credentialEvent).toBe(true);
    expect(meta.outcome).toBe('accessed');
    expect(meta.skill).toBe('email');
    expect(meta.credentialType).toBe('smtp_password');
  });

  test('logCredentialDenied records denial with reason', () => {
    logCredentialDenied(bb, {
      skill: 'calendar',
      credentialType: 'oauth_token',
      reason: 'scope not allowed',
    });

    const events = bb.eventQueries.getRecent(5);
    const credEvent = events.find((e) => e.summary.includes('Credential denied'));
    expect(credEvent).toBeDefined();
    expect(credEvent!.summary).toContain('scope not allowed');

    const meta = JSON.parse(credEvent!.metadata!);
    expect(meta.outcome).toBe('denied');
    expect(meta.reason).toBe('scope not allowed');
  });

  test('multiple credential events are recorded independently', () => {
    logCredentialAccess(bb, { skill: 'email', credentialType: 'imap' });
    logCredentialAccess(bb, { skill: 'calendar', credentialType: 'oauth' });
    logCredentialDenied(bb, { skill: 'custom', credentialType: 'api_key', reason: 'not configured' });

    const events = bb.eventQueries.getRecent(10);
    const credEvents = events.filter((e) =>
      e.metadata?.includes('"credentialEvent":true')
    );
    expect(credEvents.length).toBe(3);
  });

  test('credential events are searchable via FTS', () => {
    logCredentialAccess(bb, { skill: 'email', credentialType: 'smtp_password' });

    const results = bb.eventQueries.search('smtp_password');
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('credential scope config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hb-scope-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns default config when file does not exist', () => {
    const config = loadScopeConfig(join(tmpDir, 'nonexistent.json'));
    expect(config.defaultPolicy).toBe('deny');
    expect(config.rules).toEqual({});
  });

  test('loads config from file', () => {
    const configPath = join(tmpDir, 'scopes.json');
    writeFileSync(configPath, JSON.stringify({
      defaultPolicy: 'deny',
      rules: {
        email: ['smtp_password', 'imap_password'],
        calendar: ['oauth_token'],
      },
    }));

    const config = loadScopeConfig(configPath);
    expect(config.defaultPolicy).toBe('deny');
    expect(config.rules.email).toEqual(['smtp_password', 'imap_password']);
    expect(config.rules.calendar).toEqual(['oauth_token']);
  });

  test('returns default config for invalid JSON', () => {
    const configPath = join(tmpDir, 'bad.json');
    writeFileSync(configPath, 'not valid json {{{');

    const config = loadScopeConfig(configPath);
    expect(config.defaultPolicy).toBe('deny');
  });
});

describe('isCredentialAllowed', () => {
  const denyConfig: CredentialScopeConfig = {
    defaultPolicy: 'deny',
    rules: {
      email: ['smtp_password', 'imap_password'],
      calendar: ['*'],
    },
  };

  const allowConfig: CredentialScopeConfig = {
    defaultPolicy: 'allow',
    rules: {
      restricted: ['api_key'],
    },
  };

  test('allows when skill has explicit rule for credential type', () => {
    expect(isCredentialAllowed('email', 'smtp_password', denyConfig)).toBe(true);
  });

  test('denies when skill rule does not include credential type', () => {
    expect(isCredentialAllowed('email', 'oauth_token', denyConfig)).toBe(false);
  });

  test('wildcard rule allows any credential type', () => {
    expect(isCredentialAllowed('calendar', 'any_credential', denyConfig)).toBe(true);
  });

  test('falls back to default deny when no rule matches', () => {
    expect(isCredentialAllowed('unknown_skill', 'api_key', denyConfig)).toBe(false);
  });

  test('falls back to default allow when no rule matches', () => {
    expect(isCredentialAllowed('unknown_skill', 'api_key', allowConfig)).toBe(true);
  });

  test('skill with explicit rule is checked even under allow-all default', () => {
    expect(isCredentialAllowed('restricted', 'api_key', allowConfig)).toBe(true);
    expect(isCredentialAllowed('restricted', 'other_cred', allowConfig)).toBe(false);
  });
});
