import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';
import { resolve } from 'path';

interface ExperimentMetric {
  current: string | number;
  target: string;
  status: 'pass' | 'fail' | 'pending';
}

interface ExperimentStatus {
  id: string;
  title: string;
  status: string;
  hypothesis: string;
  sessionsCollected: number;
  sessionsNeeded: number;
  metrics: Record<string, ExperimentMetric>;
  ready: boolean;
  summary: string;
}

interface ExperimentTrackerOutput {
  experiments: ExperimentStatus[];
  reflectionsLoaded: number;
}

interface ExperimentTrackerConfig {
  ladderDir: string;
}

/**
 * Parse experiment tracker config from a checklist item's config fields.
 */
export function parseExperimentTrackerConfig(item: ChecklistItem): ExperimentTrackerConfig {
  const defaultLadderDir = resolve(process.env.HOME || '~', 'work/sandbox/Ladder');

  return {
    ladderDir:
      typeof item.config.ladder_dir === 'string'
        ? resolve(item.config.ladder_dir.replace(/^~/, process.env.HOME || '~'))
        : defaultLadderDir,
  };
}

/**
 * Fetch experiment status via experiment-tracker.ts script.
 * Injectable for testing.
 */
export type ExperimentTrackerFetcher = (config: ExperimentTrackerConfig) => Promise<ExperimentTrackerOutput>;

let experimentTrackerFetcher: ExperimentTrackerFetcher = defaultExperimentTrackerFetcher;

async function defaultExperimentTrackerFetcher(config: ExperimentTrackerConfig): Promise<ExperimentTrackerOutput> {
  const trackerScript = resolve(config.ladderDir, 'Tools/experiment-tracker.ts');

  try {
    const proc = Bun.spawn(['bun', 'run', trackerScript, '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: config.ladderDir,
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) {
      const errorOutput = await new Response(proc.stderr).text();
      throw new Error(`Experiment tracker script failed (exit ${proc.exitCode}): ${errorOutput}`);
    }

    const parsed = JSON.parse(output);
    return parsed as ExperimentTrackerOutput;
  } catch (err: unknown) {
    throw err;
  }
}

/**
 * Override the experiment tracker fetcher (for testing).
 */
export function setExperimentTrackerFetcher(fetcher: ExperimentTrackerFetcher): void {
  experimentTrackerFetcher = fetcher;
}

/**
 * Reset to default experiment tracker fetcher.
 */
export function resetExperimentTrackerFetcher(): void {
  experimentTrackerFetcher = defaultExperimentTrackerFetcher;
}

/**
 * Check if any metrics are failing (early warning).
 */
function findFailingMetrics(experiment: ExperimentStatus): string[] {
  const failing: string[] = [];

  for (const [name, metric] of Object.entries(experiment.metrics)) {
    if (metric.status === 'fail') {
      failing.push(`${name}: ${metric.current} (target ${metric.target})`);
    }
  }

  return failing;
}

/**
 * Evaluate experiment tracker check for a checklist item.
 */
export async function evaluateExperimentTracker(item: ChecklistItem): Promise<CheckResult> {
  const config = parseExperimentTrackerConfig(item);

  try {
    const data = await experimentTrackerFetcher(config);

    if (data.experiments.length === 0) {
      return {
        item,
        status: 'ok',
        summary: `Experiment tracker: ${item.name} — no active experiments`,
        details: { experimentCount: 0, reflectionsLoaded: data.reflectionsLoaded },
      };
    }

    // Check for experiments ready for analysis
    const readyExperiments = data.experiments.filter(exp => exp.ready);
    if (readyExperiments.length > 0) {
      const readyList = readyExperiments.map(exp =>
        `${exp.id} ready for analysis (${exp.sessionsCollected}/${exp.sessionsNeeded} sessions)`
      );

      return {
        item,
        status: 'alert',
        summary: `Experiment tracker: ${item.name} — ${readyExperiments.length} experiment(s) ready for analysis`,
        details: {
          experimentCount: data.experiments.length,
          readyExperiments: readyList,
          reflectionsLoaded: data.reflectionsLoaded,
        },
      };
    }

    // Check for failing metrics (early warning)
    const experimentsWithFailures: string[] = [];
    for (const exp of data.experiments) {
      const failing = findFailingMetrics(exp);
      if (failing.length > 0) {
        experimentsWithFailures.push(`${exp.id}: ${failing.join(', ')}`);
      }
    }

    if (experimentsWithFailures.length > 0) {
      return {
        item,
        status: 'alert',
        summary: `Experiment tracker: ${item.name} — ${experimentsWithFailures.length} experiment(s) with metric drift`,
        details: {
          experimentCount: data.experiments.length,
          metricWarnings: experimentsWithFailures,
          reflectionsLoaded: data.reflectionsLoaded,
        },
      };
    }

    // All experiments are progressing normally
    const progressList = data.experiments.map(exp =>
      `${exp.id}: ${exp.sessionsCollected}/${exp.sessionsNeeded} sessions`
    );

    return {
      item,
      status: 'ok',
      summary: `Experiment tracker: ${item.name} — ${data.experiments.length} experiment(s) in progress`,
      details: {
        experimentCount: data.experiments.length,
        progress: progressList,
        reflectionsLoaded: data.reflectionsLoaded,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `Experiment tracker: ${item.name} — error: ${msg}`,
      details: { error: msg },
    };
  }
}
