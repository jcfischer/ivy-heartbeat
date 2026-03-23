import { describe, test, expect, afterEach } from 'bun:test';
import {
  evaluateExperimentTracker,
  parseExperimentTrackerConfig,
  setExperimentTrackerFetcher,
  resetExperimentTrackerFetcher,
} from '../src/evaluators/experiment-tracker.ts';
import type { ChecklistItem } from '../src/parser/types.ts';

function makeItem(config: Record<string, unknown> = {}): ChecklistItem {
  return {
    name: 'Ladder Experiments',
    type: 'experiment_tracker',
    severity: 'medium',
    channels: ['terminal'],
    enabled: true,
    description: 'Monitor active Ladder experiments',
    config,
  };
}

describe('parseExperimentTrackerConfig', () => {
  test('returns default ladder_dir when no config', () => {
    const config = parseExperimentTrackerConfig(makeItem());
    expect(config.ladderDir).toContain('work/sandbox/Ladder');
  });

  test('reads custom ladder_dir', () => {
    const config = parseExperimentTrackerConfig(makeItem({
      ladder_dir: '~/custom/path/Ladder',
    }));
    expect(config.ladderDir).toContain('custom/path/Ladder');
  });

  test('expands ~ in ladder_dir', () => {
    const config = parseExperimentTrackerConfig(makeItem({
      ladder_dir: '~/work/test',
    }));
    expect(config.ladderDir).not.toContain('~');
    expect(config.ladderDir).toContain('work/test');
  });
});

describe('evaluateExperimentTracker', () => {
  afterEach(() => {
    resetExperimentTrackerFetcher();
  });

  test('returns ok when no active experiments', async () => {
    setExperimentTrackerFetcher(async () => ({
      experiments: [],
      reflectionsLoaded: 100,
    }));

    const result = await evaluateExperimentTracker(makeItem());
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('no active experiments');
    expect(result.details?.experimentCount).toBe(0);
  });

  test('returns ok when experiments are in progress', async () => {
    setExperimentTrackerFetcher(async () => ({
      experiments: [
        {
          id: 'EX-00001',
          title: 'Test Experiment',
          status: 'active',
          hypothesis: 'HY-00001',
          sessionsCollected: 5,
          sessionsNeeded: 20,
          metrics: {
            'Sessions collected': {
              current: 5,
              target: '20',
              status: 'pending',
            },
          },
          ready: false,
          summary: '5/20 sessions collected',
        },
      ],
      reflectionsLoaded: 100,
    }));

    const result = await evaluateExperimentTracker(makeItem());
    expect(result.status).toBe('ok');
    expect(result.summary).toContain('in progress');
    expect(result.details?.experimentCount).toBe(1);
  });

  test('returns alert when experiment is ready for analysis', async () => {
    setExperimentTrackerFetcher(async () => ({
      experiments: [
        {
          id: 'EX-00002',
          title: 'Ready Experiment',
          status: 'active',
          hypothesis: 'HY-00002',
          sessionsCollected: 20,
          sessionsNeeded: 20,
          metrics: {
            'Sessions collected': {
              current: 20,
              target: '20',
              status: 'pass',
            },
          },
          ready: true,
          summary: 'Ready for analysis! 1/1 metrics passing.',
        },
      ],
      reflectionsLoaded: 100,
    }));

    const result = await evaluateExperimentTracker(makeItem());
    expect(result.status).toBe('alert');
    expect(result.summary).toContain('ready for analysis');
    expect(result.details?.readyExperiments).toBeInstanceOf(Array);
  });

  test('returns alert when metrics are failing', async () => {
    setExperimentTrackerFetcher(async () => ({
      experiments: [
        {
          id: 'EX-00003',
          title: 'Failing Experiment',
          status: 'active',
          hypothesis: 'HY-00003',
          sessionsCollected: 10,
          sessionsNeeded: 20,
          metrics: {
            'Verification regret': {
              current: '30%',
              target: '<10%',
              status: 'fail',
            },
            'Sessions collected': {
              current: 10,
              target: '20',
              status: 'pending',
            },
          },
          ready: false,
          summary: '10/20 sessions collected',
        },
      ],
      reflectionsLoaded: 100,
    }));

    const result = await evaluateExperimentTracker(makeItem());
    expect(result.status).toBe('alert');
    expect(result.summary).toContain('metric drift');
    expect(result.details?.metricWarnings).toBeInstanceOf(Array);
  });

  test('handles multiple experiments with mixed states', async () => {
    setExperimentTrackerFetcher(async () => ({
      experiments: [
        {
          id: 'EX-00001',
          title: 'In Progress',
          status: 'active',
          hypothesis: 'HY-00001',
          sessionsCollected: 5,
          sessionsNeeded: 20,
          metrics: {
            'Sessions': { current: 5, target: '20', status: 'pending' },
          },
          ready: false,
          summary: '5/20 sessions',
        },
        {
          id: 'EX-00002',
          title: 'Ready',
          status: 'active',
          hypothesis: 'HY-00002',
          sessionsCollected: 20,
          sessionsNeeded: 20,
          metrics: {
            'Sessions': { current: 20, target: '20', status: 'pass' },
          },
          ready: true,
          summary: 'Ready!',
        },
      ],
      reflectionsLoaded: 100,
    }));

    const result = await evaluateExperimentTracker(makeItem());
    // Should alert about ready experiment (higher priority)
    expect(result.status).toBe('alert');
    expect(result.summary).toContain('ready for analysis');
  });

  test('handles fetcher error gracefully', async () => {
    setExperimentTrackerFetcher(async () => {
      throw new Error('Script execution failed');
    });

    const result = await evaluateExperimentTracker(makeItem());
    expect(result.status).toBe('error');
    expect(result.summary).toContain('Script execution failed');
  });
});
