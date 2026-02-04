import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';
import type { Blackboard } from '../blackboard.ts';
import { dispatch } from '../scheduler/scheduler.ts';
import type { DispatchOptions, DispatchResult } from '../scheduler/types.ts';

interface AgentDispatchConfig {
  maxConcurrent: number;
  maxItems: number;
  timeout: number;
  priority?: string;
}

function parseDispatchConfig(item: ChecklistItem): AgentDispatchConfig {
  return {
    maxConcurrent: typeof item.config.max_concurrent === 'number' ? item.config.max_concurrent : 1,
    maxItems: typeof item.config.max_items === 'number' ? item.config.max_items : 1,
    timeout: typeof item.config.timeout_minutes === 'number' ? item.config.timeout_minutes : 60,
    priority: typeof item.config.priority === 'string' ? item.config.priority : undefined,
  };
}

// ─── Injectable blackboard accessor (set by runner) ──────────────────────

let bbRef: Blackboard | null = null;

export function setDispatchBlackboard(bb: Blackboard): void {
  bbRef = bb;
}

export function resetDispatchBlackboard(): void {
  bbRef = null;
}

// ─── Injectable dispatcher (for testing) ─────────────────────────────────

export type DispatchFn = (bb: Blackboard, opts: DispatchOptions) => Promise<DispatchResult>;

let dispatchFn: DispatchFn = dispatch;

export function setDispatchFn(fn: DispatchFn): void {
  dispatchFn = fn;
}

export function resetDispatchFn(): void {
  dispatchFn = dispatch;
}

/**
 * Evaluate agent dispatch: check for available work items and dispatch them.
 */
export async function evaluateAgentDispatch(item: ChecklistItem): Promise<CheckResult> {
  if (!bbRef) {
    return {
      item,
      status: 'error',
      summary: `Agent dispatch: ${item.name} — blackboard not configured`,
      details: { error: 'Blackboard not set. Call setDispatchBlackboard() before evaluating.' },
    };
  }

  const config = parseDispatchConfig(item);

  try {
    const result = await dispatchFn(bbRef, {
      maxConcurrent: config.maxConcurrent,
      maxItems: config.maxItems,
      timeout: config.timeout,
      dryRun: false,
      priority: config.priority,
      fireAndForget: true,
    });

    const dispatched = result.dispatched.length;
    const completed = result.dispatched.filter((d) => d.completed).length;
    const errors = result.errors.length;
    const skipped = result.skipped.length;

    if (errors > 0) {
      return {
        item,
        status: 'alert',
        summary: `Agent dispatch: ${item.name} — ${dispatched} dispatched, ${errors} error(s)`,
        details: {
          dispatched,
          completed,
          errors,
          skipped,
          errorDetails: result.errors.map((e) => `${e.itemId}: ${e.error}`),
        },
      };
    }

    if (dispatched > 0) {
      const launched = result.dispatched.filter((d) => !d.completed).length;
      const summaryParts: string[] = [];
      if (launched > 0) summaryParts.push(`${launched} launched`);
      if (completed > 0) summaryParts.push(`${completed} completed`);

      return {
        item,
        status: 'ok',
        summary: `Agent dispatch: ${item.name} — ${summaryParts.join(', ')}`,
        details: {
          dispatched,
          launched,
          completed,
          errors: 0,
          skipped,
          items: result.dispatched.map((d) => ({
            id: d.itemId,
            title: d.title,
            completed: d.completed,
            durationMs: d.durationMs,
          })),
        },
      };
    }

    return {
      item,
      status: 'ok',
      summary: `Agent dispatch: ${item.name} — no available work items`,
      details: { dispatched: 0, completed: 0, errors: 0, skipped },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `Agent dispatch: ${item.name} — error: ${msg}`,
      details: { error: msg },
    };
  }
}
