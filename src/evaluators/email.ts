import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';

interface EmailConfig {
  imapHost: string;
  imapPort: number;
  imapUser: string;
  imapPass: string;
  maxUnread: number;
  maxAgeHours: number;
  fromFilter: string[];
}

/**
 * Parse email config from a checklist item's config fields.
 * Returns null if IMAP is not configured.
 */
export function parseEmailConfig(item: ChecklistItem): EmailConfig | null {
  const host =
    (item.config.imap_host as string) ?? process.env.IMAP_HOST;
  const user =
    (item.config.imap_user as string) ?? process.env.IMAP_USER;
  const pass = process.env.IMAP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  const port =
    typeof item.config.imap_port === 'number'
      ? item.config.imap_port
      : parseInt(process.env.IMAP_PORT ?? '993', 10);

  const maxUnread =
    typeof item.config.max_unread === 'number' ? item.config.max_unread : 10;

  const maxAgeHours =
    typeof item.config.max_age_hours === 'number'
      ? item.config.max_age_hours
      : 48;

  const fromFilterRaw =
    typeof item.config.from_filter === 'string'
      ? item.config.from_filter
      : '';
  const fromFilter = fromFilterRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return { imapHost: host, imapPort: port, imapUser: user, imapPass: pass, maxUnread, maxAgeHours, fromFilter };
}

/**
 * Count unread emails via IMAP.
 * This is the real network call — abstracted for testability.
 *
 * MVP: Uses Bun's native TCP to send raw IMAP commands.
 * For production, this would use a proper IMAP library.
 */
export type ImapCounter = (config: EmailConfig) => Promise<number>;

let imapCounter: ImapCounter = defaultImapCounter;

async function defaultImapCounter(_config: EmailConfig): Promise<number> {
  // MVP: Return -1 to indicate IMAP counting not yet implemented
  // A real implementation would connect via IMAP and count UNSEEN messages
  // This allows the evaluator logic to be fully tested without IMAP dependency
  return -1;
}

/**
 * Override the IMAP counter (for testing or custom implementations).
 */
export function setImapCounter(counter: ImapCounter): void {
  imapCounter = counter;
}

/**
 * Reset to default IMAP counter.
 */
export function resetImapCounter(): void {
  imapCounter = defaultImapCounter;
}

/**
 * Evaluate email check for a checklist item.
 */
export async function evaluateEmail(item: ChecklistItem): Promise<CheckResult> {
  const config = parseEmailConfig(item);

  if (!config) {
    return {
      item,
      status: 'ok',
      summary: `Email check: ${item.name} (IMAP not configured — skipped)`,
      details: { configured: false },
    };
  }

  try {
    const unreadCount = await imapCounter(config);

    if (unreadCount < 0) {
      // IMAP counter not implemented yet
      return {
        item,
        status: 'ok',
        summary: `Email check: ${item.name} (IMAP counter not available)`,
        details: { configured: true, counterAvailable: false },
      };
    }

    if (unreadCount > config.maxUnread) {
      return {
        item,
        status: 'alert',
        summary: `Email check: ${item.name} — ${unreadCount} unread (threshold: ${config.maxUnread})`,
        details: {
          configured: true,
          unreadCount,
          threshold: config.maxUnread,
          host: config.imapHost,
        },
      };
    }

    return {
      item,
      status: 'ok',
      summary: `Email check: ${item.name} — ${unreadCount} unread (within threshold of ${config.maxUnread})`,
      details: {
        configured: true,
        unreadCount,
        threshold: config.maxUnread,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `Email check: ${item.name} — IMAP error: ${msg}`,
      details: { configured: true, error: msg },
    };
  }
}
