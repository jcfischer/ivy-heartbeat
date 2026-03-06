# Implementation Tasks: F-028 Dead Letter Queue + Typed Failure States

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| **Phase 1: ivy-blackboard Schema** | | |
| T-1.1 | ☐ | Determine next migration number in `ivy-blackboard/drizzle/` |
| T-1.2 | ☐ | Write migration: ADD COLUMN failure_count, failure_reason, failed_at |
| T-1.3 | ☐ | Run migration on local DB, verify existing rows have failure_count=0 |
| **Phase 2: ivy-blackboard Types** | | |
| T-2.1 | ☐ | Extend `WorkItemStatus` type: add `'failed'` and `'quarantined'` |
| T-2.2 | ☐ | Add `failure_count`, `failure_reason`, `failed_at` to `WorkItem` interface |
| T-2.3 | ☐ | Update Zod schema if work items validated on read |
| **Phase 3: ivy-blackboard API Functions** | | |
| T-3.1 | ☐ | Implement `failWorkItem(db, itemId, reason)` in `src/work-items.ts` |
| T-3.2 | ☐ | Auto-quarantine logic inside `failWorkItem` at count >= 3 |
| T-3.3 | ☐ | Implement `quarantineWorkItem(db, itemId, reason)` in `src/work-items.ts` |
| T-3.4 | ☐ | Implement `getFailedItems(db)` in `src/work-items.ts` |
| T-3.5 | ☐ | Implement `requeueWorkItem(db, itemId)` in `src/work-items.ts` |
| T-3.6 | ☐ | Verify `listWorkItems({status:'pending'})` already excludes quarantined (status != pending) |
| T-3.7 | ☐ | Expose all 4 new functions on `Blackboard` class in `src/blackboard.ts` |
| **Phase 4: ivy-blackboard Tests** | | |
| T-4.1 | ☐ | Create `test/work-items/failure.test.ts` |
| T-4.2 | ☐ | Test: `failWorkItem` sets status='failed', increments failure_count |
| T-4.3 | ☐ | Test: `failWorkItem` sets failed_at to non-null datetime |
| T-4.4 | ☐ | Test: `failWorkItem` on 3rd call auto-quarantines |
| T-4.5 | ☐ | Test: `failWorkItem` on 2nd call does NOT quarantine |
| T-4.6 | ☐ | Test: `quarantineWorkItem` sets status='quarantined' and failure_reason |
| T-4.7 | ☐ | Test: `getFailedItems` returns only failed/quarantined items |
| T-4.8 | ☐ | Test: `getFailedItems` excludes pending/completed items |
| T-4.9 | ☐ | Test: `listWorkItems({status:'pending'})` excludes quarantined |
| T-4.10 | ☐ | Test: `requeueWorkItem` resets status, failure_count=0, failure_reason=NULL |
| T-4.11 | ☐ | Run `bun test` in ivy-blackboard — all tests pass |
| **Phase 5: ivy-heartbeat Dispatch Worker** | | |
| T-5.1 | ☐ | Locate failure path in `src/commands/dispatch-worker.ts` |
| T-5.2 | ☐ | Wrap agent execution in try/catch; call `bb.failWorkItem(item.id, err.message)` on failure |
| T-5.3 | ☐ | Handle non-zero exit code from launcher as failure (call `bb.failWorkItem`) |
| T-5.4 | ☐ | Log quarantine event to blackboard event log when item is quarantined |
| **Phase 6: ivy-heartbeat Retry CLI Command** | | |
| T-6.1 | ☐ | Create `src/commands/retry.ts` |
| T-6.2 | ☐ | Read item by ID, validate it exists and status is 'failed' or 'quarantined' |
| T-6.3 | ☐ | Display current failure_count and failure_reason before requeue |
| T-6.4 | ☐ | Call `bb.requeueWorkItem(itemId)`, print confirmation |
| T-6.5 | ☐ | Wire `retry <item-id>` subcommand into `src/cli.ts` |
| **Phase 7: ivy-heartbeat Dashboard** | | |
| T-7.1 | ☐ | Create `src/serve/views/quarantine-panel.ts` |
| T-7.2 | ☐ | Query `bb.getFailedItems()` in panel |
| T-7.3 | ☐ | Render table: item ID, title, failure_count, failure_reason, failed_at |
| T-7.4 | ☐ | Add `POST /api/work-items/:id/retry` route to server |
| T-7.5 | ☐ | Integrate quarantine panel into existing dashboard view |
| **Phase 8: ivy-heartbeat Tests** | | |
| T-8.1 | ☐ | Create `test/commands/retry.test.ts` |
| T-8.2 | ☐ | Test: retry succeeds for quarantined item |
| T-8.3 | ☐ | Test: retry errors for non-existent item |
| T-8.4 | ☐ | Test: retry errors for completed (non-quarantined) item |
| T-8.5 | ☐ | Test: dispatch-worker calls failWorkItem on agent failure |
| T-8.6 | ☐ | Integration test: 3 dispatch failures → item quarantined |
| T-8.7 | ☐ | Run `bun test` in ivy-heartbeat — all 490+ tests pass |

## Task Details

### T-1.2 — Migration SQL
```sql
-- ivy-blackboard/drizzle/0NNN_add_work_item_failure_fields.ts
ALTER TABLE work_items ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN failure_reason TEXT;
ALTER TABLE work_items ADD COLUMN failed_at DATETIME;
```
Note: Do NOT attempt to modify the `status` CHECK constraint via ALTER TABLE (SQLite limitation). Status validation enforced at Zod/TypeScript layer only.

### T-3.1 — failWorkItem Implementation
```typescript
export function failWorkItem(db: Database, itemId: string, reason: string): void {
  db.run(`UPDATE work_items
    SET failure_count = failure_count + 1,
        failed_at = datetime('now'),
        status = 'failed'
    WHERE id = ?`, [itemId]);
  const item = db.query<{failure_count: number}>(
    'SELECT failure_count FROM work_items WHERE id = ?', [itemId]
  ).get();
  if (item && item.failure_count >= 3) {
    quarantineWorkItem(db, itemId, `Failed ${item.failure_count} times: ${reason}`);
  }
}
```

### T-3.3 — quarantineWorkItem Implementation
```typescript
export function quarantineWorkItem(db: Database, itemId: string, reason: string): void {
  db.run(`UPDATE work_items SET status = 'quarantined', failure_reason = ? WHERE id = ?`,
    [reason, itemId]);
}
```

### T-3.4 — getFailedItems Implementation
```typescript
export function getFailedItems(db: Database): WorkItem[] {
  return db.query<WorkItem>(`SELECT * FROM work_items
    WHERE status IN ('failed', 'quarantined')
    ORDER BY failed_at DESC`).all();
}
```

### T-3.5 — requeueWorkItem Implementation
```typescript
export function requeueWorkItem(db: Database, itemId: string): void {
  db.run(`UPDATE work_items
    SET status = 'pending', failure_count = 0, failure_reason = NULL, failed_at = NULL
    WHERE id = ?`, [itemId]);
}
```

## Acceptance Criteria Checklist

- [ ] AC-1: `failure_count`, `failure_reason`, `failed_at` columns exist on `work_items`
- [ ] AC-2: `'failed'` and `'quarantined'` accepted as valid status values
- [ ] AC-3: `failWorkItem` increments count; auto-quarantines at 3
- [ ] AC-4: `quarantineWorkItem` sets status and reason
- [ ] AC-5: `listWorkItems({status:'pending'})` excludes quarantined items
- [ ] AC-6: `getFailedItems()` returns quarantined items
- [ ] AC-7: Dashboard shows quarantined items with details
- [ ] AC-8: `ivy-heartbeat retry <id>` CLI command works
- [ ] AC-9: All 490+ existing tests pass; new tests cover full failure→quarantine→retry cycle
