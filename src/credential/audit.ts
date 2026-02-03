import type { Blackboard } from '../blackboard.ts';
import type { CredentialAccessEvent } from './types.ts';

/**
 * Log a successful credential access event to the blackboard.
 */
export function logCredentialAccess(
  bb: Blackboard,
  event: Omit<CredentialAccessEvent, 'outcome'>
): void {
  bb.appendEvent({
    summary: `Credential accessed: ${event.credentialType} by ${event.skill}`,
    metadata: {
      credentialEvent: true,
      skill: event.skill,
      credentialType: event.credentialType,
      outcome: 'accessed',
    },
  });
}

/**
 * Log a denied credential access event to the blackboard.
 */
export function logCredentialDenied(
  bb: Blackboard,
  event: Omit<CredentialAccessEvent, 'outcome'> & { reason: string }
): void {
  bb.appendEvent({
    summary: `Credential denied: ${event.credentialType} for ${event.skill} — ${event.reason}`,
    metadata: {
      credentialEvent: true,
      skill: event.skill,
      credentialType: event.credentialType,
      outcome: 'denied',
      reason: event.reason,
    },
  });
}
