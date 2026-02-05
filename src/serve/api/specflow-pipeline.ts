import type { Blackboard } from '../../blackboard.ts';

export interface PipelineFeature {
  feature_id: string;
  feature_name: string;
  current_phase: string;
  phase_statuses: Array<{
    phase: string;
    status: 'completed' | 'in_progress' | 'pending' | 'failed';
  }>;
  worktree_path: string | null;
  created_at: string | null;
  last_activity: string | null;
}

const ALL_PHASES = ['specify', 'plan', 'tasks', 'implement', 'complete'];

/**
 * Query the blackboard for SpecFlow pipeline status per feature.
 * Groups work items by specflow_feature_id from metadata JSON.
 */
export function getSpecFlowPipelines(bb: Blackboard): PipelineFeature[] {
  const items = bb.listWorkItems({ all: true });

  // Group by feature ID
  const features = new Map<string, {
    items: Array<{
      phase: string;
      status: string;
      worktree_path?: string;
      created_at?: string;
      updated_at?: string;
      title: string;
    }>;
  }>();

  for (const item of items) {
    if (!item.metadata) continue;
    try {
      const meta = JSON.parse(item.metadata);
      if (!meta.specflow_feature_id || !meta.specflow_phase) continue;

      const featureId = meta.specflow_feature_id;
      if (!features.has(featureId)) {
        features.set(featureId, { items: [] });
      }
      features.get(featureId)!.items.push({
        phase: meta.specflow_phase,
        status: item.status,
        worktree_path: meta.worktree_path,
        created_at: item.created_at,
        updated_at: item.updated_at,
        title: item.title,
      });
    } catch {
      continue;
    }
  }

  // Build pipeline view per feature
  const pipelines: PipelineFeature[] = [];

  for (const [featureId, data] of features) {
    const completedPhases = new Set<string>();
    const failedPhases = new Set<string>();
    let currentPhase = 'specify';
    let worktreePath: string | null = null;
    let createdAt: string | null = null;
    let lastActivity: string | null = null;

    for (const item of data.items) {
      if (item.status === 'completed') {
        completedPhases.add(item.phase);
      } else if (item.status === 'failed') {
        failedPhases.add(item.phase);
      } else if (item.status === 'claimed' || item.status === 'available') {
        currentPhase = item.phase;
      }

      if (item.worktree_path) {
        worktreePath = item.worktree_path;
      }

      if (item.created_at && (!createdAt || item.created_at < createdAt)) {
        createdAt = item.created_at;
      }

      if (item.updated_at && (!lastActivity || item.updated_at > lastActivity)) {
        lastActivity = item.updated_at;
      }
    }

    const phaseStatuses = ALL_PHASES.map((phase) => {
      if (completedPhases.has(phase)) return { phase, status: 'completed' as const };
      if (failedPhases.has(phase)) return { phase, status: 'failed' as const };
      if (phase === currentPhase) return { phase, status: 'in_progress' as const };
      return { phase, status: 'pending' as const };
    });

    // Derive a feature name from the most descriptive title
    const featureName = data.items[0]?.title
      ?.replace(/^SpecFlow \w+: /, '')
      ?.replace(featureId, '')
      ?.trim() || featureId;

    pipelines.push({
      feature_id: featureId,
      feature_name: featureName || featureId,
      current_phase: currentPhase,
      phase_statuses: phaseStatuses,
      worktree_path: worktreePath,
      created_at: createdAt,
      last_activity: lastActivity,
    });
  }

  return pipelines;
}
