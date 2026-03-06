import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, cleanupTestContext, type TestContext } from '../helpers.ts';
import { createWorkItem } from 'ivy-blackboard/src/work';

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  cleanupTestContext(ctx);
});

function seedWorkItem(id: string, status: string = 'available', failureCount: number = 0, failureReason: string | null = null): void {
  createWorkItem(ctx.bb.db, { id, title: `Item ${id}`, source: 'local', priority: 'P2' });
  if (status !== 'available' || failureCount > 0 || failureReason) {
    ctx.bb.db.query(`
      UPDATE work_items
      SET status = ?, failure_count = ?, failure_reason = ?, failed_at = CASE WHEN ? > 0 THEN datetime('now') ELSE NULL END
      WHERE item_id = ?
    `).run(status, failureCount, failureReason, failureCount, id);
  }
}

describe("bb.requeueWorkItem (backing retry command)", () => {
  test("succeeds for quarantined item — resets to available", () => {
    seedWorkItem('witem-q', 'quarantined', 3, 'too many failures');

    ctx.bb.requeueWorkItem('witem-q');

    const row = ctx.bb.db
      .query('SELECT * FROM work_items WHERE item_id = ?')
      .get('witem-q') as any;
    expect(row.status).toBe('available');
    expect(row.failure_count).toBe(0);
    expect(row.failure_reason).toBeNull();
    expect(row.failed_at).toBeNull();
  });

  test("succeeds for failed item — resets to available", () => {
    seedWorkItem('witem-f', 'failed', 2);

    ctx.bb.requeueWorkItem('witem-f');

    const row = ctx.bb.db
      .query('SELECT * FROM work_items WHERE item_id = ?')
      .get('witem-f') as any;
    expect(row.status).toBe('available');
    expect(row.failure_count).toBe(0);
  });

  test("on non-existent item is a no-op (no throw)", () => {
    expect(() => ctx.bb.requeueWorkItem('witem-nonexistent')).not.toThrow();
  });
});

describe("bb.failWorkItem", () => {
  test("marks item failed with correct status", () => {
    seedWorkItem('witem-1');

    ctx.bb.failWorkItem('witem-1', 'Agent crashed');

    const row = ctx.bb.db
      .query('SELECT * FROM work_items WHERE item_id = ?')
      .get('witem-1') as any;
    expect(row.status).toBe('failed');
    expect(row.failure_count).toBe(1);
    expect(row.failed_at).not.toBeNull();
  });

  test("after 3 failures, item is quarantined", () => {
    seedWorkItem('witem-1');

    ctx.bb.failWorkItem('witem-1', 'Error 1');
    ctx.bb.failWorkItem('witem-1', 'Error 2');
    ctx.bb.failWorkItem('witem-1', 'Error 3');

    const row = ctx.bb.db
      .query('SELECT * FROM work_items WHERE item_id = ?')
      .get('witem-1') as any;
    expect(row.status).toBe('quarantined');
    expect(row.failure_count).toBe(3);
    expect(row.failure_reason).toContain('3 times');
  });

  test("quarantined item not returned by getFailedItems as available", () => {
    seedWorkItem('witem-1');

    ctx.bb.failWorkItem('witem-1', 'e1');
    ctx.bb.failWorkItem('witem-1', 'e2');
    ctx.bb.failWorkItem('witem-1', 'e3');

    // Item should be in failed/quarantined list
    const failedItems = ctx.bb.getFailedItems();
    expect(failedItems.find((i) => i.item_id === 'witem-1')).toBeDefined();

    // Item should NOT be in available dispatch queue
    const available = ctx.bb.listWorkItems();
    expect(available.find((i) => i.item_id === 'witem-1')).toBeUndefined();
  });
});

describe("retry dispatch cycle simulation", () => {
  test("after retry, quarantined item re-enters the dispatch queue", () => {
    seedWorkItem('witem-merge', 'quarantined', 3, 'Failed 3 times: gh pr merge failed');

    // Operator investigates and retries
    ctx.bb.requeueWorkItem('witem-merge');

    // Item should now be available
    const available = ctx.bb.listWorkItems();
    const found = available.find((i) => i.item_id === 'witem-merge');
    expect(found).toBeDefined();
    expect(found?.status).toBe('available');

    // And not in quarantine list
    const failed = ctx.bb.getFailedItems();
    expect(failed.find((i) => i.item_id === 'witem-merge')).toBeUndefined();
  });
});
