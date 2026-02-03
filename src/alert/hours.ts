import { DEFAULT_ACTIVE_HOURS, type ActiveHoursConfig } from './types.ts';

/**
 * Check if the current time is within active hours.
 * Default: 08:00–22:00 in system timezone.
 */
export function isWithinActiveHours(
  now: Date = new Date(),
  config: ActiveHoursConfig = DEFAULT_ACTIVE_HOURS
): boolean {
  const hour = now.getHours();
  return hour >= config.start && hour < config.end;
}
