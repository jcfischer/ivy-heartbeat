import type { CheckResult } from '../check/types.ts';

const VOICE_SERVER_URL = 'http://localhost:8888/notify';
const TIMEOUT_MS = 3000;

/**
 * Send a voice notification via the PAI voice server.
 * Returns true on success, false on failure (server down, timeout).
 */
export async function notifyVoice(result: CheckResult): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(VOICE_SERVER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Heartbeat ${result.status}: ${result.item.name}. ${result.summary}`,
      }),
      signal: controller.signal,
    });

    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
