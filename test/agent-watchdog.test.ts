import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  evaluateAgentWatchdog,
  setWatchdogBlackboard,
  resetWatchdogBlackboard,
} from '../src/evaluators/agent-watchdog.ts';
import type { ChecklistItem } from '../src/parser/types.ts';
import { Blackboard } from '../src/blackboard.ts';

function makeItem(config: Record<string, unknown> = {}): ChecklistItem {
  return {
    name: 'Agent Watchdog',
    type: 'agent_watchdog',
    severity: 'high',
    channels: ['terminal', 'voice'],
    enabled: true,
    description: 'Detect stuck agents and retry failed tasks',
    config,
  };
}

describe('agent-watchdog evaluator', () => {
  let bb: Blackboard;

  beforeEach(() => {
    bb = new Blackboard(':memory:');
    setWatchdogBlackboard(bb);
  });

  afterEach(() => {
    resetWatchdogBlackboard();
    bb.close();
  });

  describe('config parsing', () => {
    test('uses default stuck_threshold_minutes of 30', async () => {
      const result = await evaluateAgentWatchdog(makeItem());
      expect(result.status).toBe('ok');
    });

    test('uses default max_retries of 2', async () => {
      const result = await evaluateAgentWatchdog(makeItem());
      expect(result.status).toBe('ok');
    });

    test('reads custom config values', async () => {
      const result = await evaluateAgentWatchdog(makeItem({
        stuck_threshold_minutes: 60,
        max_retries: 3,
      }));
      expect(result.status).toBe('ok');
    });
  });

  describe('stuck agent detection', () => {
    test('returns ok when no stuck agents', async () => {
      // Register fresh agent (won't be stale)
      bb.registerAgent({ name: 'test-agent' });

      const result = await evaluateAgentWatchdog(makeItem());
      expect(result.status).toBe('ok');
      expect(result.summary).toContain('no recovery needed');
    });

    test('detects and recovers stuck agent with claimed work', async () => {
      // Register agent with old heartbeat
      const agentResult = bb.registerAgent({ name: 'stuck-agent' });

      // Create and claim work item
      bb.createWorkItem({
        id: 'test-item-1',
        title: 'Test Work',
      });
      bb.claimWorkItem('test-item-1', agentResult.session_id);

      // Manually set old last_seen_at and dead PID to simulate stale agent
      const oldTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 min ago
      bb.db.query("UPDATE agents SET last_seen_at = ?, pid = ? WHERE session_id = ?")
        .run(oldTimestamp, 999999, agentResult.session_id); // 999999 likely doesn't exist

      const result = await evaluateAgentWatchdog(makeItem({ stuck_threshold_minutes: 30 }));

      expect(result.status).toBe('alert');
      expect(result.summary).toContain('stuck agent(s) recovered');
      expect(result.details?.staleAgentCount).toBe(1);
      expect(result.details?.releasedItemCount).toBe(1);
    });
  });

  describe('failed task retry', () => {
    test('returns ok when no failed tasks', async () => {
      const result = await evaluateAgentWatchdog(makeItem());
      expect(result.status).toBe('ok');
    });

    test('requeues failed task with failure_count < max_retries', async () => {
      // Create work item
      bb.createWorkItem({
        id: 'failed-item-1',
        title: 'Failed Work',
              });

      // Mark as failed
      bb.failWorkItem('failed-item-1', 'Test failure');

      const result = await evaluateAgentWatchdog(makeItem({ max_retries: 2 }));

      expect(result.status).toBe('alert');
      expect(result.summary).toContain('failed task(s) requeued');
      expect(result.details?.requeuedCount).toBe(1);

      // Verify task was requeued
      const item = bb.listWorkItems({ all: true }).find(i => i.item_id === 'failed-item-1');
      expect(item?.status).toBe('available');
      expect(item?.failure_count).toBe(0);
    });

    test('does not requeue task at failure threshold', async () => {
      // Create work item
      bb.createWorkItem({
        id: 'failed-item-2',
        title: 'Failed Work',
              });

      // Fail multiple times to hit threshold (2 failures with max_retries=1)
      bb.failWorkItem('failed-item-2', 'Failure 1');
      bb.requeueWorkItem('failed-item-2');
      bb.failWorkItem('failed-item-2', 'Failure 2');

      const result = await evaluateAgentWatchdog(makeItem({ max_retries: 1 }));

      // Should not requeue since failure_count (2) >= max_retries (1)
      expect(result.details?.requeuedCount).toBe(0);
    });
  });

  describe('error handling', () => {
    test('returns error when blackboard not set', async () => {
      resetWatchdogBlackboard();
      const result = await evaluateAgentWatchdog(makeItem());

      expect(result.status).toBe('error');
      expect(result.summary).toContain('blackboard not configured');
    });

    test('handles exceptions gracefully', async () => {
      // Close db to trigger exception
      bb.close();

      const result = await evaluateAgentWatchdog(makeItem());

      expect(result.status).toBe('error');
      expect(result.summary).toContain('error');
    });
  });

  describe('result details', () => {
    test('includes staleAgents array with session info', async () => {
      const agentResult = bb.registerAgent({ name: 'old-agent' });
      const oldTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      bb.db.query("UPDATE agents SET last_seen_at = ?, pid = ? WHERE session_id = ?")
        .run(oldTimestamp, 999999, agentResult.session_id);

      const result = await evaluateAgentWatchdog(makeItem({ stuck_threshold_minutes: 30 }));

      expect(result.details?.staleAgents).toBeDefined();
      expect(result.details?.staleAgents).toHaveLength(1);
      expect(result.details?.staleAgents[0].agentName).toBe('old-agent');
    });

    test('includes requeuedTasks array with item IDs', async () => {
      bb.createWorkItem({
        id: 'requeue-test',
        title: 'Test',
              });
      bb.failWorkItem('requeue-test', 'Test failure');

      const result = await evaluateAgentWatchdog(makeItem());

      expect(result.details?.requeuedTasks).toBeDefined();
      expect(result.details?.requeuedTasks).toHaveLength(1);
      expect(result.details?.requeuedTasks[0].itemId).toBe('requeue-test');
    });
  });
});
