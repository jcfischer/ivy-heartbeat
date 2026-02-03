import type { ChecklistItem, CheckType } from '../parser/types.ts';
import type { CheckResult } from './types.ts';

export type Evaluator = (item: ChecklistItem) => Promise<CheckResult>;

/**
 * Evaluator registry.
 * F-007 provides stubs. Real implementations come in later features:
 * - calendar: F-018
 * - email: F-017
 * - custom: future
 */
const evaluators: Record<CheckType, Evaluator> = {
  calendar: async (item) => ({
    item,
    status: 'ok',
    summary: `Calendar check: ${item.name} (stub — no conflicts detected)`,
  }),

  email: async (item) => ({
    item,
    status: 'ok',
    summary: `Email check: ${item.name} (stub — no matching emails)`,
  }),

  custom: async (item) => ({
    item,
    status: 'ok',
    summary: `Custom check: ${item.name} (stub — ok)`,
  }),
};

/**
 * Get the evaluator for a check type.
 */
export function getEvaluator(type: CheckType): Evaluator {
  return evaluators[type];
}

/**
 * Register a custom evaluator (for testing or future override).
 */
export function registerEvaluator(type: CheckType, evaluator: Evaluator): void {
  evaluators[type] = evaluator;
}
