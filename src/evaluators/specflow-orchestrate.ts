import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';
import type { Blackboard } from '../blackboard.ts';
import { orchestrateSpecFlow } from '../scheduler/specflow/orchestrator.ts';

// ─── Injectable blackboard accessor (for testing) ─────────────────────

let bbAccessor: Blackboard | null = null;

export function setOrchestratorBlackboard(accessor: Blackboard): void {
  bbAccessor = accessor;
}

export function resetOrchestratorBlackboard(): void {
  bbAccessor = null;
}

// ─── Config parsing ───────────────────────────────────────────────────

interface OrchestrateConfig {
  max_concurrent: number;
  phase_timeout_min: number;
}

function parseConfig(item: ChecklistItem): OrchestrateConfig {
  return {
    max_concurrent: typeof item.config.max_concurrent === 'number'
      ? item.config.max_concurrent
      : 3,
    phase_timeout_min: typeof item.config.phase_timeout_min === 'number'
      ? item.config.phase_timeout_min
      : 90,
  };
}

// ─── Evaluator ────────────────────────────────────────────────────────

/**
 * Feature-flag-gated SpecFlow orchestrator evaluator.
 *
 * Disabled during Phases 1–3 of F-027 via SPECFLOW_ORCHESTRATOR env var.
 * Enable by setting SPECFLOW_ORCHESTRATOR=true in the environment.
 */
export async function evaluateSpecFlowOrchestrate(item: ChecklistItem): Promise<CheckResult> {
  // Feature flag gate
  if (process.env.SPECFLOW_ORCHESTRATOR !== 'true') {
    return {
      item,
      status: 'ok',
      summary: `SpecFlow orchestrate: ${item.name} — disabled (SPECFLOW_ORCHESTRATOR not set)`,
      details: { enabled: false },
    };
  }

  if (!bbAccessor) {
    return {
      item,
      status: 'error',
      summary: `SpecFlow orchestrate: ${item.name} — blackboard not configured`,
      details: { error: 'Blackboard accessor not set.' },
    };
  }

  const config = parseConfig(item);

  try {
    const result = await orchestrateSpecFlow(bbAccessor, {
      maxConcurrent: config.max_concurrent,
      phaseTimeoutMin: config.phase_timeout_min,
    });

    const hasErrors = result.errors.length > 0;
    const status = hasErrors ? 'alert' : 'ok';

    const parts: string[] = [];
    if (result.featuresProcessed === 0) {
      parts.push('no actionable features');
    } else {
      parts.push(`processed ${result.featuresProcessed}`);
      if (result.featuresAdvanced > 0) parts.push(`advanced ${result.featuresAdvanced}`);
      if (result.featuresReleased > 0) parts.push(`released ${result.featuresReleased}`);
      if (result.featuresFailed > 0) parts.push(`failed ${result.featuresFailed}`);
    }

    return {
      item,
      status,
      summary: `SpecFlow orchestrate: ${item.name} — ${parts.join(', ')}`,
      details: {
        featuresProcessed: result.featuresProcessed,
        featuresAdvanced: result.featuresAdvanced,
        featuresReleased: result.featuresReleased,
        featuresFailed: result.featuresFailed,
        errors: result.errors,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `SpecFlow orchestrate: ${item.name} — error: ${msg}`,
      details: { error: msg },
    };
  }
}
