import type { SpecFlowFeature } from '../types.ts';
import { BasePhaseExecutor } from './base-executor.ts';

export class SpecifyExecutor extends BasePhaseExecutor {
  readonly phaseName = 'specify';
  readonly artifactName = 'spec.md';

  canRun(feature: SpecFlowFeature): boolean {
    return feature.phase === 'queued' || feature.phase === 'specifying';
  }
}
