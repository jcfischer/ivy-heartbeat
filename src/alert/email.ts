import type { CheckResult } from '../check/types.ts';

/**
 * Send an email notification.
 * MVP stub: always returns false (email not configured).
 * Future: implement with SMTP when config.smtp_to is provided.
 */
export async function notifyEmail(_result: CheckResult): Promise<boolean> {
  return false;
}
