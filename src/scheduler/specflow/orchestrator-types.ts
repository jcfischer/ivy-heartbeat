export type OrchestratorAction =
  | { type: 'wait'; reason: string }
  | { type: 'release'; reason: string }
  | { type: 'advance'; fromPhase: string; toPhase: string }
  | { type: 'run-phase'; phase: string }
  | { type: 'check-gate'; gate: string }
  | { type: 'fail'; reason: string };

export interface OrchestratorConfig {
  /** Max features running simultaneously. */
  maxConcurrent: number;
  /** Minutes before a phase is considered stuck and released. */
  phaseTimeoutMin: number;
}

export interface OrchestratorResult {
  featuresProcessed: number;
  featuresAdvanced: number;
  featuresReleased: number;
  featuresFailed: number;
  errors: Array<{ featureId: string; error: string }>;
}

/** Maps *ed phases to the next *ing phase they advance to. */
export const ADVANCE_MAP: Record<string, string> = {
  queued: 'specifying',
  specified: 'planning',
  planned: 'tasking',
  tasked: 'implementing',
  implemented: 'completing',
};

/** Gates to run after each *ing phase succeeds. */
export const GATE_MAP: Record<string, 'quality' | 'artifact' | 'code' | 'pass'> = {
  specifying: 'quality',
  planning: 'quality',
  tasking: 'artifact',
  implementing: 'code',
  completing: 'pass',
};

/** Converts an *ing phase to its *ed counterpart. */
export function toCompletedPhase(phase: string): string {
  const map: Record<string, string> = {
    specifying: 'specified',
    planning: 'planned',
    tasking: 'tasked',
    implementing: 'implemented',
    completing: 'completed',
  };
  return map[phase] ?? phase;
}
