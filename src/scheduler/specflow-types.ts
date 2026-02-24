/**
 * Types and helpers for SpecFlow dispatch integration.
 */

export type SpecFlowPhase = 'specify' | 'plan' | 'tasks' | 'implement' | 'complete';

export interface SpecFlowWorkItemMetadata {
  specflow_feature_id: string;
  specflow_phase: SpecFlowPhase;
  specflow_project_id: string;
  worktree_path?: string;
  main_branch?: string;
  retry_count?: number;
  eval_feedback?: string;
  // GitHub issue tracking — carried through chains for evaluator dedup
  github_issue_url?: string;
  github_issue_number?: number;
  github_repo?: string;
}

/** Phase → next phase (null = pipeline done) */
export const PHASE_TRANSITIONS: Record<SpecFlowPhase, SpecFlowPhase | null> = {
  specify: 'plan',
  plan: 'tasks',
  tasks: 'implement',
  implement: 'complete',
  complete: null,
};

/** Phases that require quality gate checks */
export const PHASE_RUBRICS: Partial<Record<SpecFlowPhase, string>> = {
  specify: 'spec-quality',
  plan: 'plan-quality',
};

/** Artifact file checked by quality gate */
export const PHASE_ARTIFACTS: Partial<Record<SpecFlowPhase, string>> = {
  specify: 'spec.md',
  plan: 'plan.md',
};

/** Prerequisite phase — which phase must be completed before this one can run */
export const PHASE_PREREQUISITES: Partial<Record<SpecFlowPhase, SpecFlowPhase>> = {
  plan: 'specify',
  tasks: 'plan',
  implement: 'tasks',
  complete: 'implement',
};

/** Expected artifact per phase — used for post-phase existence validation */
export const PHASE_EXPECTED_ARTIFACTS: Partial<Record<SpecFlowPhase, string>> = {
  specify: 'spec.md',
  plan: 'plan.md',
  tasks: 'tasks.md',
};

/**
 * Parse and validate SpecFlow metadata from a work item's metadata JSON string.
 * Returns null if metadata is missing, invalid, or not a SpecFlow item.
 *
 * Accepts both canonical (specflow_*) and shorthand (phase, feature_id) key formats.
 * Shorthand keys are normalized to canonical format to prevent silent dispatch failures
 * when work items are created outside the standard evaluator pipeline.
 */
export function parseSpecFlowMeta(metadata: string | null): SpecFlowWorkItemMetadata | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata);
    // Canonical keys
    if (parsed.specflow_phase && parsed.specflow_feature_id && parsed.specflow_project_id) {
      return parsed as SpecFlowWorkItemMetadata;
    }
    // Shorthand keys — normalize to canonical
    const phase = parsed.phase ?? parsed.specflow_phase;
    const featureId = parsed.feature_id ?? parsed.specflow_feature_id;
    const projectId = parsed.project_id ?? parsed.specflow_project_id;
    if (phase && featureId && projectId) {
      return {
        ...parsed,
        specflow_phase: phase,
        specflow_feature_id: featureId,
        specflow_project_id: projectId,
      } as SpecFlowWorkItemMetadata;
    }
  } catch {
    // Invalid JSON
  }
  return null;
}

/** Result from runSpecFlowPhase — replaces ambiguous boolean return */
export type SpecFlowPhaseResult = {
  status: 'completed' | 'failed' | 'retry' | 'blocked';
  /** Next phase chained (if any) */
  nextPhase?: SpecFlowPhase;
  /** Retry work item ID (if status === 'retry') */
  retryItemId?: string;
};

/**
 * Get the next phase in the pipeline, or null if complete.
 */
export function nextPhase(current: SpecFlowPhase): SpecFlowPhase | null {
  return PHASE_TRANSITIONS[current];
}
