import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

export const PLIST_LABEL = 'com.pai.ivy-heartbeat';
export const DEFAULT_INTERVAL_MINUTES = 60;

export interface PlistConfig {
  /** Absolute path to the ivy-heartbeat binary (compiled or bun script) */
  binaryPath: string;
  /** If set, binaryPath is bun and this is the script path */
  scriptPath?: string;
  intervalSeconds: number;
  logDir: string;
  dbPath?: string;
}

/**
 * Generate a launchd plist XML string.
 * All paths must be absolute — no ~ or relative paths.
 */
export function generatePlist(config: PlistConfig): string {
  const args: string[] = [];

  if (config.scriptPath) {
    // Running from source: bun run cli.ts check
    args.push(`    <string>${escapeXml(config.binaryPath)}</string>`);
    args.push(`    <string>${escapeXml(config.scriptPath)}</string>`);
  } else {
    // Compiled binary: ivy-heartbeat check
    args.push(`    <string>${escapeXml(config.binaryPath)}</string>`);
  }

  if (config.dbPath) {
    args.push(`    <string>--db</string>`);
    args.push(`    <string>${escapeXml(config.dbPath)}</string>`);
  }

  args.push(`    <string>check</string>`);

  const home = homedir();
  const binDir = join(home, 'bin');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.join('\n')}
  </array>
  <key>StartInterval</key>
  <integer>${config.intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${escapeXml(join(config.logDir, 'ivy-heartbeat.stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(config.logDir, 'ivy-heartbeat.stderr.log'))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>AbandonProcessGroup</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
    <key>PATH</key>
    <string>${escapeXml(binDir)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Resolve the absolute path to the bun binary.
 */
export async function resolveBunPath(): Promise<string> {
  const proc = Bun.spawn(['which', 'bun'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;

  const bunPath = text.trim();
  if (!bunPath || proc.exitCode !== 0) {
    throw new Error('bun binary not found. Is bun installed and in PATH?');
  }
  return bunPath;
}

/**
 * Check if running as a compiled binary (not bun + source).
 *
 * In compiled Bun binaries, process.argv[0] is just "bun" and
 * process.execPath is the compiled binary (e.g. /path/ivy-heartbeat).
 * In source mode, process.execPath is the bun runtime itself.
 */
export function isCompiledBinary(): boolean {
  const ep = process.execPath;
  return !!(ep && !ep.endsWith('/bun') && !ep.endsWith('/node'));
}

/**
 * Resolve the absolute path to the ivy-heartbeat binary.
 * Returns process.execPath for compiled binaries,
 * or the cli.ts source path for development.
 */
export function resolveCliPath(): string {
  if (isCompiledBinary()) {
    return resolve(process.execPath);
  }
  return resolve(dirname(import.meta.dir), 'cli.ts');
}

/**
 * Resolve the absolute log directory path, creating it if needed.
 */
export function resolveLogDir(): string {
  const logDir = join(homedir(), '.pai', 'logs');
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  return logDir;
}

/**
 * Resolve the absolute plist file path.
 */
export function resolvePlistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${PLIST_LABEL}.plist`);
}

/**
 * Parse the interval from the plist XML (returns minutes).
 */
export function parseIntervalFromPlist(xml: string): number | null {
  const match = xml.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
  if (!match) return null;
  return Math.round(parseInt(match[1], 10) / 60);
}
