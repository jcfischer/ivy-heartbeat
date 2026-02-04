import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  generatePlist,
  resolvePlistPath,
  parseIntervalFromPlist,
  PLIST_LABEL,
  DEFAULT_INTERVAL_MINUTES,
} from '../src/schedule/plist.ts';

/** Source-mode config: bun + script */
const SAMPLE_CONFIG = {
  binaryPath: '/opt/homebrew/bin/bun',
  scriptPath: '/tmp/ivy-heartbeat/src/cli.ts',
  intervalSeconds: 3600,
  logDir: '/tmp/ivy-heartbeat/logs',
};

/** Compiled-binary config */
const COMPILED_CONFIG = {
  binaryPath: '/opt/local/bin/ivy-heartbeat',
  intervalSeconds: 600,
  logDir: '/tmp/ivy-heartbeat/logs',
};

describe('generatePlist', () => {
  test('produces valid XML with correct label', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    expect(xml).toContain(`<string>${PLIST_LABEL}</string>`);
    expect(xml).toStartWith('<?xml version="1.0"');
    expect(xml).toContain('<!DOCTYPE plist');
  });

  test('source mode: contains bun path and script path', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    expect(xml).toContain('<string>/opt/homebrew/bin/bun</string>');
    expect(xml).toContain('<string>/tmp/ivy-heartbeat/src/cli.ts</string>');
  });

  test('compiled mode: contains only binary path, no script path', () => {
    const xml = generatePlist(COMPILED_CONFIG);
    expect(xml).toContain('<string>/opt/local/bin/ivy-heartbeat</string>');
    expect(xml).not.toContain('cli.ts');
    expect(xml).not.toContain('bun</string>');
  });

  test('contains check subcommand in ProgramArguments', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    expect(xml).toContain('<string>check</string>');
  });

  test('contains correct StartInterval', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    expect(xml).toContain('<integer>3600</integer>');
  });

  test('interval conversion: 30 min = 1800 seconds', () => {
    const xml = generatePlist({ ...SAMPLE_CONFIG, intervalSeconds: 30 * 60 });
    expect(xml).toContain('<integer>1800</integer>');
  });

  test('interval conversion: 15 min = 900 seconds', () => {
    const xml = generatePlist({ ...SAMPLE_CONFIG, intervalSeconds: 15 * 60 });
    expect(xml).toContain('<integer>900</integer>');
  });

  test('contains stdout log path', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    expect(xml).toContain('/tmp/ivy-heartbeat/logs/ivy-heartbeat.stdout.log');
  });

  test('contains stderr log path', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    expect(xml).toContain('/tmp/ivy-heartbeat/logs/ivy-heartbeat.stderr.log');
  });

  test('has RunAtLoad set to true', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('<true/>');
  });

  test('includes PATH environment variable with ~/bin', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    expect(xml).toContain('<key>PATH</key>');
    expect(xml).toContain('/opt/homebrew/bin');
    expect(xml).toContain('/bin:');
  });

  test('includes HOME environment variable', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    expect(xml).toContain('<key>HOME</key>');
  });

  test('includes AbandonProcessGroup', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    expect(xml).toContain('<key>AbandonProcessGroup</key>');
    expect(xml).toContain('<true/>');
  });

  test('no tilde in output', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    expect(xml).not.toContain('~/');
  });

  test('includes --db flag when dbPath provided', () => {
    const xml = generatePlist({ ...SAMPLE_CONFIG, dbPath: '/tmp/test.db' });
    expect(xml).toContain('<string>--db</string>');
    expect(xml).toContain('<string>/tmp/test.db</string>');
  });

  test('excludes --db flag when dbPath not provided', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    expect(xml).not.toContain('--db');
  });

  test('escapes XML special characters in paths', () => {
    const xml = generatePlist({ ...SAMPLE_CONFIG, binaryPath: '/path/with<special>&chars' });
    expect(xml).toContain('&lt;special&gt;&amp;chars');
    expect(xml).not.toContain('<special>');
  });

  test('--db comes before check in args', () => {
    const xml = generatePlist({ ...SAMPLE_CONFIG, dbPath: '/tmp/test.db' });
    const dbIdx = xml.indexOf('--db');
    const checkIdx = xml.indexOf('<string>check</string>');
    expect(dbIdx).toBeGreaterThan(-1);
    expect(checkIdx).toBeGreaterThan(dbIdx);
  });
});

describe('resolvePlistPath', () => {
  test('returns path under ~/Library/LaunchAgents', () => {
    const path = resolvePlistPath();
    expect(path).toBe(join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`));
  });

  test('path is absolute', () => {
    const path = resolvePlistPath();
    expect(path.startsWith('/')).toBe(true);
  });
});

describe('parseIntervalFromPlist', () => {
  test('extracts interval in minutes from plist XML', () => {
    const xml = generatePlist(SAMPLE_CONFIG);
    const interval = parseIntervalFromPlist(xml);
    expect(interval).toBe(60);
  });

  test('extracts 30 minute interval', () => {
    const xml = generatePlist({ ...SAMPLE_CONFIG, intervalSeconds: 1800 });
    const interval = parseIntervalFromPlist(xml);
    expect(interval).toBe(30);
  });

  test('returns null for invalid XML', () => {
    const interval = parseIntervalFromPlist('<plist>no interval</plist>');
    expect(interval).toBeNull();
  });
});

describe('DEFAULT_INTERVAL_MINUTES', () => {
  test('is 60 minutes', () => {
    expect(DEFAULT_INTERVAL_MINUTES).toBe(60);
  });
});
