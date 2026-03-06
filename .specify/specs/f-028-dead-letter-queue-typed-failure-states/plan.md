# F-028: Dead Letter Queue + Typed Failure States — Implementation Plan

## Requirement Mapping

| Spec Acceptance Criterion | Implementation Approach |
|--------------------------|------------------------|
| AC-1: `failure_count`, `failure_reason`, `failed_at` columns on `work_items` | Migration `0NNN_add_work_item_failure_fields.ts` in `ivy-blackboard/drizzle/` |
| AC-2: `status` accepts `'failed'` and `'quarantined'` | Extend `WorkItemStatus` union type; enforce at Zod layer |
| AC-3: `failWorkItem(id, reason)` increments count; auto-quarantines at 3 | New function in `ivy-blackboard/src/work-items.ts`, enforces threshold internally |
| AC-4: `quarantineWorkItem(id, reason)` sets status and reason | New function in `ivy-blackboard/src/work-items.ts` |
| AC-5: `listWorkItems({status:'pending'})` excludes quarantined | Update WHERE clause in existing `listWorkItems` query |
| AC-6: `getFailedItems()` returns quarantined items | New query in `ivy-blackboard/src/work-items.ts` |
| AC-7: Dashboard shows quarantined items | Add quarantine panel to `ivy-heartbeat/src/serve/views/` |
| AC-8: `ivy-heartbeat retry <id>` CLI command | New `retry.ts` command, wired into `src/cli.ts` |
| AC-9: 490+ tests pass; new tests cover full cycle | Unit tests in `ivy-blackboard/test/`, integration in `ivy-heartbeat/test/` |

### Scope Verification
- In spec, in plan: failure counting, quarantine, dashboard, retry CLI, test coverage
- In spec, NOT in plan: None (all ACs covered above)
- NOT in spec, in plan: None (no scope creep)

## Architecture

```
┌─────────────────────┐     ┌──────────────────────────┐     ┌──────────────────┐
│  ivy-heartbeat      │     │  ivy-blackboard           │     │  SQLite DB       │
│  (consumer)         │     │  (store)                   │     │  work_items      │
│                     │     │                            │     │  + failure cols  │
│  dispatch-worker.ts │────>│  failWorkItem()            │────>│  failure_count   │
│  retry.ts (CLI)     │────>│  quarantineWorkItem()      │     │  failure_reason  │
│  dashboard view     │<────│  getFailedItems()          │<────│  failed_at       │
│                     │     │  requeueWorkItem()         │     │  status          │
└─────────────────────┘     └──────────────────────────┘     └──────────────────┘
```

### Component Responsibilities

- **`ivy-blackboard/src/work-items.ts`** — All failure state logic. Single file owns the 3-failure threshold, quarantine promotion, and requeue. No business logic in consumers.
- **`ivy-blackboard/src/blackboard.ts`** — Exposes `bb.failWorkItem()`, `bb.quarantineWorkItem()`, `bb.getFailedItems()`, `bb.requeueWorkItem()` as public API. Thin delegation only.
- **`ivy-heartbeat/src/commands/dispatch-worker.ts`** — Calls `bb.failWorkItem()` on work item failure. Does NOT enforce the 3-failure threshold (that's ivy-blackboard's job).
- **`ivy-heartbeat/src/commands/retry.ts`** — CLI command. Reads item, calls `bb.requeueWorkItem()`, prints confirmation.
- **`ivy-heartbeat/src/serve/views/quarantine-panel.ts`** — Dashboard widget. Calls `bb.getFailedItems()`, renders table.

### Pattern Alignment
Follows the existing pattern in `ivy-blackboard/src/work-items.ts`:
- Pure functions that receive a `db: Database` parameter
- Exposed via `Blackboard` class in `blackboard.ts`
- No singleton state — all operations are explicit DB calls

## File Structure

```
ivy-blackboard/
├── drizzle/
│   └── 0NNN_add_work_item_failure_fields.ts   # NEW: migration
├── src/
│   ├── work-items.ts                           # MODIFIED: add 4 new functions
│   ├── blackboard.ts                           # MODIFIED: expose 4 new functions
│   └── types.ts                                # MODIFIED: extend WorkItemStatus, WorkItem

ivy-heartbeat/
├── src/
│   ├── commands/
│   │   ├── dispatch-worker.ts                  # MODIFIED: call bb.failWorkItem on failure
│   │   └── retry.ts                            # NEW: retry CLI command
│   ├── serve/
│   │   └── views/
│   │       └── quarantine-panel.ts             # NEW: dashboard quarantine widget
│   └── cli.ts                                  # MODIFIED: register retry command
└── test/
    └── commands/
        └── retry.test.ts                       # NEW: retry command tests
```

## Data Model

```typescript
// ivy-blackboard/src/types.ts (additions)
export type WorkItemStatus =
  | 'pending' | 'running' | 'completed'
  | 'failed'       // NEW: temporary, may retry
  | 'quarantined'; // NEW: permanent, excluded from dispatch

export interface WorkItem {
  // ... existing fields ...
  failure_count: number;        // NEW: default 0
  failure_reason: string | null; // NEW: set on quarantine
  failed_at: string | null;     // NEW: ISO datetime of last failure
}
```

```sql
-- Migration: ivy-blackboard/drizzle/0NNN_add_work_item_failure_fields.ts
ALTER TABLE work_items ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN failure_reason TEXT;
ALTER TABLE work_items ADD COLUMN failed_at DATETIME;
-- status CHECK constraint: extended at application layer (Zod), not SQLite DDL
```

## API Contracts

```typescript
// ivy-blackboard/src/work-items.ts

function failWorkItem(db: Database, itemId: string, reason: string): void {
  db.run(`UPDATE work_items
    SET failure_count = failure_count + 1,
        failed_at = datetime('now'),
        status = 'failed'
    WHERE id = ?`, [itemId]);
  const item = db.query<{failure_count: number}>('SELECT failure_count FROM work_items WHERE id = ?', [itemId]).get();
  if (item && item.failure_count >= 3) {
    quarantineWorkItem(db, itemId, `Failed ${item.failure_count} times: ${reason}`);
  }
}

function quarantineWorkItem(db: Database, itemId: string, reason: string): void {
  db.run(`UPDATE work_items SET status = 'quarantined', failure_reason = ? WHERE id = ?`,
    [reason, itemId]);
}

function getFailedItems(db: Database): WorkItem[] {
  return db.query<WorkItem>(`SELECT * FROM work_items
    WHERE status IN ('failed', 'quarantined')
    ORDER BY failed_at DESC`).all();
}

function requeueWorkItem(db: Database, itemId: string): void {
  db.run(`UPDATE work_items
    SET status = 'pending', failure_count = 0, failure_reason = NULL, failed_at = NULL
    WHERE id = ?`, [itemId]);
}
```

```
CLI: ivy-heartbeat retry <item-id>
  On success: "Requeued witem-abc123 (was quarantined after 3 failures)"
  On not found: "Error: work item witem-abc123 not found"
  On wrong status: "Error: work item is not failed or quarantined (status: completed)"
```

## Failure Mode Analysis

| Component | Failure Mode | Detection | Recovery | Blast Radius |
|-----------|-------------|-----------|----------|--------------|
| `failWorkItem` DB call | SQLite write error | Exception thrown | Caller catches; item stays in previous state | Item not marked failed; may retry indefinitely |
| `quarantineWorkItem` after `failWorkItem` | Second DB write fails | Exception in `failWorkItem` | Log error; item stuck at `status='failed'` with count=3 | Item may be re-dispatched once more before next failure catches it |
| `getFailedItems` | Query error | Exception | Return empty array (dashboard shows nothing) | Quarantine panel hidden; no user data loss |
| `requeueWorkItem` | Item not found | 0 rows affected | CLI reports "not found" | No change to DB state |
| Dashboard quarantine panel | View error | Server error | Panel renders empty or skipped | Other dashboard panels unaffected |

### Graceful Degradation
- DB unavailable: `failWorkItem` throws → dispatch-worker catches → logs error → item re-enters queue (acceptable: better than silent data loss)
- `getFailedItems` returns error: dashboard renders quarantine section as empty rather than crashing
- `retry` command: validates item exists and is quarantined before calling `requeueWorkItem`

### Blast Radius Assessment
- This feature affects: `work_items` table, `dispatch-worker`, `retry CLI`, dashboard
- Does NOT affect: specflow orchestrator, PR review pipeline, calendar evaluator, agent sessions

## Test Strategy

### Unit Tests — `ivy-blackboard/test/work-items/failure.test.ts`

| Test Case | Maps to AC | Type |
|-----------|-----------|------|
| `failWorkItem` sets status='failed', increments failure_count | AC-3 | Unit |
| `failWorkItem` sets failed_at to current timestamp | AC-1 | Unit |
| `failWorkItem` on 3rd call auto-calls `quarantineWorkItem` | AC-3 | Unit |
| `failWorkItem` on 2nd call does NOT quarantine | AC-3 | Unit |
| `quarantineWorkItem` sets status='quarantined' and failure_reason | AC-4 | Unit |
| `getFailedItems` returns only failed/quarantined items | AC-6 | Unit |
| `getFailedItems` excludes pending/completed items | AC-6 | Unit |
| `listWorkItems({status:'pending'})` excludes quarantined items | AC-5 | Unit |
| `requeueWorkItem` resets status, failure_count, failure_reason | AC-8 | Unit |
| `requeueWorkItem` on non-existent ID is a no-op | AC-8 | Unit |

### Integration Tests — `ivy-heartbeat/test/commands/retry.test.ts`

| Test Case | Maps to AC | Type |
|-----------|-----------|------|
| `ivy-heartbeat retry <id>` succeeds for quarantined item | AC-8 | Integration |
| `ivy-heartbeat retry <id>` errors for non-existent item | AC-8 | Integration |
| `ivy-heartbeat retry <id>` errors for completed item | AC-8 | Integration |
| Dispatch-worker calls `failWorkItem` on agent exit code ≠ 0 | AC-3 | Integration |
| After 3 dispatch failures, item is quarantined | AC-3, AC-5 | Integration |

### Regression
- Run `bun test` — all existing 490+ tests must pass
- Verify migration doesn't break existing work items (failure_count defaults to 0)

## Implementation Sequence

1. **ivy-blackboard migration** — Add columns, run migration, verify existing rows unaffected
2. **ivy-blackboard types** — Extend `WorkItemStatus`, `WorkItem` interface
3. **ivy-blackboard functions** — Implement `failWorkItem`, `quarantineWorkItem`, `getFailedItems`, `requeueWorkItem`
4. **ivy-blackboard tests** — Unit tests (all 10 cases above), `bun test` passes
5. **ivy-blackboard release** — Bump version, publish to npm or link locally in ivy-heartbeat
6. **ivy-heartbeat dispatch-worker** — Wrap execution in try/catch, call `bb.failWorkItem` on failure
7. **ivy-heartbeat retry command** — `src/commands/retry.ts` + wire into `cli.ts`
8. **ivy-heartbeat dashboard** — `quarantine-panel.ts`, integrate into serve view
9. **ivy-heartbeat tests** — Integration tests (5 cases above), `bun test` passes
