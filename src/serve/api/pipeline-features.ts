/**
 * Pipeline features API - Correlates specflow features DB with blackboard work items
 */

import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import type { Blackboard } from '../../blackboard.ts';
import type {
  FeaturePipeline,
  PhaseStatus,
  PRMetadata,
  ReviewMetadata,
  PipelineTiming,
} from './pipeline-types.ts';
import { ALL_PIPELINE_PHASES } from './pipeline-types.ts';
import { safeJSONParse } from '../../lib/json-utils.ts';

interface SpecFlowFeature {
  id: string;
  name: string;
  phase: string;
  status: string;
  spec_path: string | null;
  created_at: string;
}

/**
 * Read features from a specflow features.db file
 * Returns empty array if DB doesn't exist or can't be read
 */
export function readSpecFlowFeatures(dbPath: string, allowedBase = process.cwd()): SpecFlowFeature[] {
  const resolvedPath = resolve(dbPath);
  const resolvedBase = resolve(allowedBase);

  // Validate DB path to prevent path traversal
  if (!dbPath.endsWith('.db') ||
      dbPath.includes('..') ||
      !resolvedPath.startsWith(resolvedBase)) {
    return [];
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.query('SELECT id, name, phase, status, spec_path, created_at FROM features').all() as SpecFlowFeature[];
    db.close();
    return rows;
  } catch (error) {
    // Graceful fallback if DB doesn't exist
    return [];
  }
}

/**
 * Extract PR metadata from work item metadata
 */
function extractPRMetadata(metadata: string, repoUrlBase = 'https://github.com'): PRMetadata | undefined {
  const meta = safeJSONParse<{ pr_number?: number; repo?: string; pr_state?: string }>(metadata);
  if (!meta || !meta.pr_number || !meta.repo) {
    return undefined;
  }

  // Ensure state is one of the valid values
  const state: 'open' | 'merged' | 'closed' =
    (meta.pr_state === 'merged' || meta.pr_state === 'closed') ? meta.pr_state : 'open';

  return {
    number: meta.pr_number,
    url: `${repoUrlBase}/${meta.repo}/pull/${meta.pr_number}`,
    state,
  };
}

/**
 * Build unified pipeline view by correlating specflow features with blackboard work items
 */
export function getFeaturePipelines(
  bb: Blackboard,
  specflowDbPath?: string,
): FeaturePipeline[] {
  // Read specflow features if DB path provided
  const specflowFeatures = specflowDbPath ? readSpecFlowFeatures(specflowDbPath) : [];
  const specflowMap = new Map(specflowFeatures.map(f => [f.id, f]));

  // Get all work items from blackboard
  const items = bb.listWorkItems({ all: true });

  // Group by feature ID
  const featureMap = new Map<string, {
    items: Array<{
      phase: string;
      status: string;
      metadata: string;
      created_at?: string;
      updated_at?: string;
      title: string;
    }>;
    project?: string;
  }>();

  for (const item of items) {
    if (!item.metadata) continue;

    const meta = safeJSONParse<{
      specflow_feature_id?: string;
      specflow_project_id?: string;
      project?: string;
      specflow_phase?: string;
    }>(item.metadata);

    if (!meta) continue; // Skip malformed JSON

    const featureId = meta.specflow_feature_id;
    const project = meta.specflow_project_id || meta.project;

    if (!featureId || !meta.specflow_phase) continue;

    if (!featureMap.has(featureId)) {
      featureMap.set(featureId, { items: [], project });
    }

    featureMap.get(featureId)!.items.push({
      phase: meta.specflow_phase,
      status: item.status,
      metadata: item.metadata,
      created_at: item.created_at,
      updated_at: item.updated_at,
      title: item.title,
    });
  }

  // Build pipeline objects
  const pipelines: FeaturePipeline[] = [];

  for (const [featureId, data] of featureMap) {
    const specflowFeature = specflowMap.get(featureId);

    // Determine feature name
    const featureName = specflowFeature?.name ||
      data.items[0]?.title?.replace(/^SpecFlow \w+: /, '')?.replace(featureId, '')?.trim() ||
      featureId;

    // Determine project
    const project = data.project || 'unknown';

    // Track phase statuses
    const completedPhases = new Set<string>();
    const failedPhases = new Set<string>();
    let currentPhase = 'specify';
    let pr: PRMetadata | undefined;
    let reviewStatus: 'approved' | 'changes_requested' | null = null;
    let reworkCycles = 0;
    let activeAgent: string | undefined;

    // Timing
    let started: string | null = null;
    let lastActivity: string | null = null;

    for (const workItem of data.items) {
      // Track phase status
      if (workItem.status === 'completed') {
        completedPhases.add(workItem.phase);
      } else if (workItem.status === 'failed') {
        failedPhases.add(workItem.phase);
      } else if (workItem.status === 'claimed') {
        currentPhase = workItem.phase;
        // Extract active agent from metadata
        const agentMeta = safeJSONParse<{ session_id?: string }>(workItem.metadata);
        if (agentMeta) {
          activeAgent = agentMeta.session_id;
        }
      } else if (workItem.status === 'available') {
        currentPhase = workItem.phase;
      }

      // Extract PR info
      const prData = extractPRMetadata(workItem.metadata);
      if (prData) {
        pr = prData;
      }

      // Track review outcomes
      const reviewMeta = safeJSONParse<{ review_result?: string }>(workItem.metadata);
      if (reviewMeta) {
        if (workItem.phase === 'review' && reviewMeta.review_result) {
          reviewStatus = reviewMeta.review_result === 'changes_requested' ? 'changes_requested' : 'approved';
        }
        if (workItem.phase === 'rework') {
          reworkCycles++;
        }
      }

      // Track timing
      if (workItem.created_at && (!started || workItem.created_at < started)) {
        started = workItem.created_at;
      }
      if (workItem.updated_at && (!lastActivity || workItem.updated_at > lastActivity)) {
        lastActivity = workItem.updated_at;
      }
    }

    // Build phase statuses
    const phases: PhaseStatus[] = ALL_PIPELINE_PHASES.map((phase) => {
      if (completedPhases.has(phase)) return { phase, status: 'completed' as const };
      if (failedPhases.has(phase)) return { phase, status: 'failed' as const };
      if (phase === currentPhase) return { phase, status: 'in_progress' as const };
      return { phase, status: 'pending' as const };
    });

    // Determine outcome
    let outcome: 'delivered' | 'in_progress' | 'failed' | 'available';
    if (completedPhases.has('merge')) {
      outcome = 'delivered';
    } else if (failedPhases.size > 0) {
      outcome = 'failed';
    } else if (currentPhase && data.items.some(i => i.status === 'claimed')) {
      outcome = 'in_progress';
    } else {
      outcome = 'available';
    }

    // Calculate duration
    const startedDate = new Date(started || Date.now());
    const lastActivityDate = new Date(lastActivity || Date.now());
    const durationMs = lastActivityDate.getTime() - startedDate.getTime();
    const durationMinutes = Math.round(durationMs / 60000);

    const timing: PipelineTiming = {
      started: started || new Date().toISOString(),
      last_activity: lastActivity || new Date().toISOString(),
      duration_minutes: durationMinutes,
    };

    const review: ReviewMetadata | undefined = (reviewStatus || reworkCycles > 0) ? {
      status: reviewStatus,
      rework_cycles: reworkCycles,
    } : undefined;

    pipelines.push({
      feature_id: featureId,
      feature_name: featureName,
      project,
      phases,
      current_phase: currentPhase,
      outcome,
      pr,
      review,
      timing,
      active_agent: activeAgent,
    });
  }

  return pipelines;
}
