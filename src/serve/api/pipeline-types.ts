/**
 * Pipeline types for the F-026 pipeline visibility dashboard
 */

/**
 * All phases in the SpecFlow pipeline, including post-implementation phases
 */
export const ALL_PIPELINE_PHASES = [
  'specify',
  'plan',
  'tasks',
  'implement',
  'complete',
  'review',
  'merge',
  'reflect',
] as const;

export type PipelinePhase = typeof ALL_PIPELINE_PHASES[number];

/**
 * Status of a single phase in the pipeline
 */
export interface PhaseStatus {
  phase: string;
  status: 'completed' | 'in_progress' | 'pending' | 'failed' | 'skipped';
}

/**
 * PR metadata for a feature
 */
export interface PRMetadata {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
}

/**
 * Review metadata including status and rework cycles
 */
export interface ReviewMetadata {
  status: 'approved' | 'changes_requested' | null;
  rework_cycles: number;
}

/**
 * Timing information for a feature's pipeline journey
 */
export interface PipelineTiming {
  started: string;          // ISO timestamp
  last_activity: string;    // ISO timestamp
  duration_minutes: number;
}

/**
 * Complete feature pipeline data
 */
export interface FeaturePipeline {
  feature_id: string;
  feature_name: string;
  project: string;
  phases: PhaseStatus[];
  current_phase: string;
  outcome: 'delivered' | 'in_progress' | 'failed' | 'available';
  pr?: PRMetadata;
  review?: ReviewMetadata;
  timing: PipelineTiming;
  active_agent?: string;  // Session ID if agent is working on it
}

/**
 * Summary statistics for the pipeline dashboard
 */
export interface PipelineSummary {
  total: number;
  delivered: number;
  in_flight: number;
  failed: number;
  agents_active: number;
  by_project: Record<string, {
    total: number;
    delivered: number;
    in_flight: number;
    failed: number;
  }>;
}
