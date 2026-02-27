import type { SpecFlowFeature } from '../types.ts';
import { BasePhaseExecutor } from './base-executor.ts';

export class TasksExecutor extends BasePhaseExecutor {
  readonly phaseName = 'tasks';
  readonly artifactName = 'tasks.md';

  canRun(feature: SpecFlowFeature): boolean {
    return feature.phase === 'planned' || feature.phase === 'tasking';
  }
}
