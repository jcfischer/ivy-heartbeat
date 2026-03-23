import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { evaluateLadderBridge, setBridgeExecutor, resetBridgeExecutor } from './ladder-bridge.ts';
import type { ChecklistItem } from '../parser/types.ts';

describe('evaluateLadderBridge', () => {
  beforeEach(() => {
    resetBridgeExecutor();
  });

  afterEach(() => {
    resetBridgeExecutor();
  });

  test('returns error when Ladder directory does not exist', async () => {
    const item: ChecklistItem = {
      name: 'Ladder Bridge',
      type: 'ladder_bridge',
      severity: 'low',
      channels: ['terminal'],
      enabled: true,
      description: 'Test',
      config: {
        ladder_dir: '/nonexistent/path',
      },
    };

    const result = await evaluateLadderBridge(item);

    expect(result.status).toBe('error');
    expect(result.summary).toContain('Ladder directory not found');
  });

  test('returns ok when no new sources are created', async () => {
    setBridgeExecutor(async () => ({
      success: true,
      created: 0,
      skipped: 99,
      output: 'Summary: 0 created, 99 skipped (already imported)',
    }));

    const item: ChecklistItem = {
      name: 'Ladder Bridge',
      type: 'ladder_bridge',
      severity: 'low',
      channels: ['terminal'],
      enabled: true,
      description: 'Test',
      config: {
        ladder_dir: '/tmp',
      },
    };

    const result = await evaluateLadderBridge(item);

    expect(result.status).toBe('ok');
    expect(result.summary).toContain('no new sources');
    expect(result.summary).toContain('99 already imported');
    expect(result.details?.created).toBe(0);
    expect(result.details?.skipped).toBe(99);
  });

  test('returns alert when new sources are created', async () => {
    setBridgeExecutor(async () => ({
      success: true,
      created: 5,
      skipped: 10,
      output: 'Summary: 5 created, 10 skipped (already imported)',
    }));

    const item: ChecklistItem = {
      name: 'Ladder Bridge',
      type: 'ladder_bridge',
      severity: 'low',
      channels: ['terminal'],
      enabled: true,
      description: 'Test',
      config: {
        ladder_dir: '/tmp',
      },
    };

    const result = await evaluateLadderBridge(item);

    expect(result.status).toBe('alert');
    expect(result.summary).toContain('5 new source(s) imported');
    expect(result.details?.created).toBe(5);
    expect(result.details?.skipped).toBe(10);
  });

  test('returns error when bridge script fails', async () => {
    setBridgeExecutor(async () => ({
      success: false,
      created: 0,
      skipped: 0,
      output: 'Script execution failed: command not found',
    }));

    const item: ChecklistItem = {
      name: 'Ladder Bridge',
      type: 'ladder_bridge',
      severity: 'low',
      channels: ['terminal'],
      enabled: true,
      description: 'Test',
      config: {
        ladder_dir: '/tmp',
      },
    };

    const result = await evaluateLadderBridge(item);

    expect(result.status).toBe('error');
    expect(result.summary).toContain('script failed');
    expect(result.details?.error).toContain('Script execution failed');
  });

  test('uses default ladder_dir when not configured', async () => {
    let capturedDir = '';
    setBridgeExecutor(async (ladderDir: string) => {
      capturedDir = ladderDir;
      return {
        success: true,
        created: 0,
        skipped: 0,
        output: '',
      };
    });

    const item: ChecklistItem = {
      name: 'Ladder Bridge',
      type: 'ladder_bridge',
      severity: 'low',
      channels: ['terminal'],
      enabled: true,
      description: 'Test',
      config: {},
    };

    await evaluateLadderBridge(item);

    expect(capturedDir).toContain('work/sandbox/Ladder');
  });

  test('uses configured ladder_dir', async () => {
    let capturedDir = '';
    setBridgeExecutor(async (ladderDir: string) => {
      capturedDir = ladderDir;
      return {
        success: true,
        created: 0,
        skipped: 0,
        output: '',
      };
    });

    const item: ChecklistItem = {
      name: 'Ladder Bridge',
      type: 'ladder_bridge',
      severity: 'low',
      channels: ['terminal'],
      enabled: true,
      description: 'Test',
      config: {
        ladder_dir: '/tmp',
      },
    };

    await evaluateLadderBridge(item);

    expect(capturedDir).toBe('/tmp');
  });
});
