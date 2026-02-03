import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { DueCheckResult } from './types.ts';

export interface CostGuardResult {
  skip: boolean;
  reason: 'no_items_due' | 'items_due';
  checklistHash: string;
  enabledCount: number;
}

/**
 * Compute SHA-256 hash of a checklist file.
 * Returns empty string if file doesn't exist.
 */
export function computeChecklistHash(filePath: string): string {
  if (!existsSync(filePath)) return '';
  const content = readFileSync(filePath, 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Determine if the evaluation loop should be skipped.
 * Skip when no items are due (all recently checked).
 */
export function shouldSkip(dueResults: DueCheckResult[]): CostGuardResult {
  const hasDueItems = dueResults.some((d) => d.isDue);

  return {
    skip: !hasDueItems,
    reason: hasDueItems ? 'items_due' : 'no_items_due',
    checklistHash: '',
    enabledCount: dueResults.length,
  };
}
