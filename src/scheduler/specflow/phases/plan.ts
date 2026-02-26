import type { SpecFlowFeature } from '../types.ts';
import { BasePhaseExecutor } from './base-executor.ts';

export class PlanExecutor extends BasePhaseExecutor {
  readonly phaseName = 'plan';
  readonly artifactName = 'plan.md';

  canRun(feature: SpecFlowFeature): boolean {
    return feature.phase === 'specified' || feature.phase === 'planning';
  }
}
