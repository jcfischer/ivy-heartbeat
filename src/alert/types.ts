import type { Channel } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';

export type ChannelHandler = (result: CheckResult) => Promise<boolean>;

export interface DispatchResult {
  delivered: Channel[];
  failed: { channel: Channel; error: string }[];
  suppressed: Channel[];
}

export interface ActiveHoursConfig {
  start: number; // hour 0-23
  end: number;   // hour 0-23
}

export const DEFAULT_ACTIVE_HOURS: ActiveHoursConfig = {
  start: 8,
  end: 22,
};
