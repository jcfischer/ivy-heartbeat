import type { ChecklistItem } from '../parser/types.ts';
import type { CostGuardResult } from './guard.ts';

export interface DueCheckResult {
  item: ChecklistItem;
  isDue: boolean;
  lastRun: string | null; // ISO timestamp
  reason: string; // "never run" | "due (65m since last)" | "not due (10m ago)"
}

export interface CheckResult {
  item: ChecklistItem;
  status: 'ok' | 'alert' | 'error';
  summary: string;
  details?: Record<string, unknown>;
}

export interface CheckSummary {
  timestamp: string;
  checked: number;
  alerts: number;
  errors: number;
  skipped: number;
  disabled: number;
  results: CheckResult[];
  dueResults: DueCheckResult[];
  guardSkipped?: boolean;
  guardResult?: CostGuardResult;
}

export interface CheckOptions {
  configPath?: string;
  dryRun?: boolean;
  verbose?: boolean;
  force?: boolean;
}
