import type { Blackboard } from '../../blackboard.ts';
import type { SpecFlowFeature } from '../../blackboard.ts';

export type { SpecFlowFeature };

export function getSpecFlowFeaturesView(bb: Blackboard): SpecFlowFeature[] {
  return bb.listFeatures() ?? [];
}
