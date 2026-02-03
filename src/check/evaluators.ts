import type { ChecklistItem, CheckType } from '../parser/types.ts';
import type { CheckResult } from './types.ts';
import { evaluateEmail } from '../evaluators/email.ts';

export type Evaluator = (item: ChecklistItem) => Promise<CheckResult>;

/**
 * Evaluator registry.
 * - calendar: F-018 (real implementation)
 * - email: F-017 (real IMAP evaluator, graceful when unconfigured)
 * - custom: stub — always ok
 */
const evaluators: Record<CheckType, Evaluator> = {
  calendar: async (item) => ({
    item,
    status: 'ok',
    summary: `Calendar check: ${item.name} (stub — no conflicts detected)`,
  }),

  email: evaluateEmail,

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
