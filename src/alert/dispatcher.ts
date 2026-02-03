import type { Channel } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';
import type { DispatchResult, ActiveHoursConfig } from './types.ts';
import { isWithinActiveHours } from './hours.ts';
import { notifyTerminal } from './terminal.ts';
import { notifyVoice } from './voice.ts';
import { notifyEmail } from './email.ts';

const handlers: Record<Channel, (result: CheckResult) => Promise<boolean>> = {
  terminal: notifyTerminal,
  voice: notifyVoice,
  email: notifyEmail,
};

/**
 * Dispatch alert notifications to configured channels.
 * Checks active hours first — suppresses all if outside window.
 * Each channel fires independently; one failure doesn't block others.
 */
export async function dispatchAlert(
  result: CheckResult,
  channels: Channel[],
  hoursConfig?: ActiveHoursConfig
): Promise<DispatchResult> {
  const dispatched: DispatchResult = {
    delivered: [],
    failed: [],
    suppressed: [],
  };

  // Check active hours
  if (!isWithinActiveHours(new Date(), hoursConfig)) {
    dispatched.suppressed = [...channels];
    return dispatched;
  }

  // Fire each channel independently
  for (const channel of channels) {
    const handler = handlers[channel];
    try {
      const success = await handler(result);
      if (success) {
        dispatched.delivered.push(channel);
      } else {
        dispatched.failed.push({ channel, error: 'handler returned false' });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatched.failed.push({ channel, error: msg });
    }
  }

  return dispatched;
}
