# F-028 Verification Report: Dead Letter Queue + Typed Failure States

**Date:** 2026-03-06
**Branch:** specflow-f-028
**Repos affected:** ivy-blackboard, ivy-heartbeat

---

## Functional Requirements Check

### AC-1: Schema columns (`failure_count`, `failure_reason`, `failed_at`)

**PASS**

Verified in `ivy-blackboard/src/schema.ts`:
- `CREATE_TABLES_SQL` (line 52–54) includes all three columns on the fresh-install path
- `MIGRATE_V7_SQL` (line 348–387) adds columns via table recreation for existing databases, sets `CURRENT_SCHEMA_VERSION = 7`
- `failed` and `quarantined` added to the status `CHECK` constraint in both DDL paths

```sql
failure_count INTEGER NOT NULL DEFAULT 0,
failure_reason TEXT,
failed_at     TEXT,
status CHECK (... 'failed', 'quarantined')
```

### AC-2: `WorkItemStatus` type includes `'failed'` and `'quarantined'`

**PASS**

`ivy-blackboard/src/types.ts` (lines 11–20):
```typescript
export const WORK_ITEM_STATUSES = [
  "available", "claimed", "completed", "blocked", "waiting_for_response",
  "failed", "quarantined",
] as const;
```
`BlackboardWorkItem` interface (lines 89–107) includes `failure_count`, `failure_reason`, and `failed_at` fields.

### AC-3: `failWorkItem(id, reason)` — increments count, auto-quarantines at 3

**PASS**

`ivy-blackboard/src/work.ts` (lines 757–781):
- Sets `status = 'failed'`, increments `failure_count`, sets `failed_at = datetime('now')`
- Re-reads count after update
- If `failure_count >= 3`, calls `quarantineWorkItem()` automatically
- Emits `work_failed` event to event log

Test coverage: `test/commands/retry.test.ts` — "after 3 failures, item is quarantined" (3 sequential `failWorkItem` calls → status becomes `quarantined`, `failure_count = 3`, `failure_reason` contains "3 times").

### AC-4: `quarantineWorkItem(id, reason)` — sets status and reason

**PASS**

`ivy-blackboard/src/work.ts` (lines 787–796):
- Sets `status = 'quarantined'` and `failure_reason = reason`
- Emits `work_quarantined` event to event log

### AC-5: `listWorkItems({status:'pending'})` excludes quarantined items

**PASS** (with terminology note)

The spec used "pending" but the codebase uses "available" as the default dispatch status — this is correct and consistent with the existing implementation. `listWorkItems()` in `ivy-blackboard/src/work.ts` (lines 608–669) defaults to `WHERE status = 'available'`, which naturally excludes `quarantined` items. The `WORK_ITEM_STATUSES` validation would reject a `quarantined` item from being treated as available.

Test coverage: "quarantined item not returned by getFailedItems as available" — calls `ctx.bb.listWorkItems()` after quarantining and confirms item is absent.

### AC-6: `getFailedItems()` returns failed/quarantined items

**PASS**

`ivy-blackboard/src/work.ts` (lines 801–807):
```typescript
return db.query<BlackboardWorkItem>(`
  SELECT * FROM work_items
  WHERE status IN ('failed', 'quarantined')
  ORDER BY failed_at DESC
`).all();
```

Test coverage: `retry.test.ts` — "quarantined item not returned by getFailedItems as available" confirms items appear in `getFailedItems()` after being quarantined.

### AC-7: Dashboard shows quarantined items with failure details

**PASS**

Three-layer implementation:
1. `src/serve/views/quarantine-panel.ts` — `renderQuarantinePanel(items)` renders a table with: item ID, title, status badge (red/orange), failure_count, failure_reason, failed_at (relative time), and a "Retry" button that calls `POST /api/work-items/:id/retry`
2. `src/serve/server.ts` (lines 104–118) — `GET /api/quarantine/panel` endpoint calls `bb.getFailedItems()` and returns the HTML panel
3. `src/serve/dashboard.ts` (lines 126–147) — `loadQuarantine()` fetches `/api/quarantine/panel` and populates the `#quarantine-panel` div; called on page load and every 30 seconds
4. Dashboard HTML (line 42) — includes `<div id="quarantine-panel">` section with "Quarantined Items" heading

### AC-8: `ivy-heartbeat retry <item-id>` CLI command

**PASS**

- `src/commands/retry.ts` — `registerRetryCommand(parent, getContext)`:
  - Reads item by `item_id` directly from DB
  - Validates existence (error + exit 1 if not found)
  - Validates status is `failed` or `quarantined` (error + exit 1 otherwise)
  - Displays current failure count and reason
  - Calls `bb.requeueWorkItem(itemId)` to reset to `available` with `failure_count = 0`
  - Prints confirmation
- `src/cli.ts` (line 16, 61) — imports and registers the retry command

Also implemented as HTTP endpoint: `POST /api/work-items/:id/retry` in `src/serve/server.ts` (lines 121–140), wired to the quarantine panel's "Retry" button.

`requeueWorkItem()` in `ivy-blackboard/src/work.ts` (lines 813–824):
- Resets `status = 'available'`, `failure_count = 0`, `failure_reason = NULL`, `failed_at = NULL`
- Emits `work_requeued` event

Test coverage in `retry.test.ts`: succeeds for quarantined items, succeeds for failed items, is a no-op for non-existent items.

### AC-9: All existing tests pass; new tests cover the failure→quarantine→retry cycle

**PASS**

See test results below.

---

## Dispatch Worker Integration

The policy is implemented in `src/commands/dispatch-worker.ts` at four failure sites:
- Line 521: merge-fix failure → `bb.failWorkItem(itemId, "Merge-fix failed: ...")`
- Line 561: rework failure → `bb.failWorkItem(itemId, "Rework failed: ...")`
- Line 635: PR merge failure → `bb.failWorkItem(itemId, "PR merge failed: ...")`
- Line 1022: agent non-zero exit → `bb.failWorkItem(itemId, "Agent exited with code ...")`
- Line 1040: generic exception → `bb.failWorkItem(itemId, msg)`

All sites follow `bb.failWorkItem(itemId, reason)` which internally enforces the 3-failure→quarantine threshold. The dispatch worker does NOT re-implement the threshold logic — it delegates entirely to `ivy-blackboard`.

---

## API Verification

| Endpoint | Method | Purpose | Status |
|----------|--------|---------|--------|
| `/api/quarantine/panel` | GET | Returns quarantine panel HTML | Implemented in `server.ts:104` |
| `/api/work-items/:id/retry` | POST | Requeues failed/quarantined item | Implemented in `server.ts:121` |

---

## Test Results

```
bun test v1.3.10 (30e609e0)

 580 pass
 0 fail
 1302 expect() calls
Ran 580 tests across 39 files. [11.74s]
```

Tests pass: 580 (up from 490 baseline — 90 new tests across new test files including `test/commands/retry.test.ts`).

New test file: `test/commands/retry.test.ts` — 7 test cases covering:
- `requeueWorkItem` resets quarantined item to available with zeroed fields
- `requeueWorkItem` resets failed item to available
- `requeueWorkItem` on non-existent item is a no-op
- `failWorkItem` sets status=failed and increments failure_count
- `failWorkItem` after 3 calls auto-quarantines with reason containing "3 times"
- Quarantined item appears in `getFailedItems()` but not in `listWorkItems()`
- After retry, quarantined item re-enters dispatch queue and disappears from quarantine list

---

## Design Deviations from Spec

| Spec Said | Implementation Did | Assessment |
|-----------|-------------------|------------|
| `status = 'pending'` for available items | Uses `status = 'available'` throughout | Correct — "pending" was a spec error; codebase uses "available" |
| `requeueWorkItem` resets `status = 'pending'` | Resets to `status = 'available'` | Correct — consistent with codebase convention |
| Migration in `drizzle/` directory | Implemented as `MIGRATE_V7_SQL` constant in `schema.ts` (applied by `db.ts` migration runner) | Correct — this is the established ivy-blackboard migration pattern |

---

## Final Verdict

**PASS**

All 9 acceptance criteria are implemented and verified:

1. Schema columns present in both fresh-install DDL and `MIGRATE_V7_SQL` migration
2. `WorkItemStatus` extended with `'failed'` and `'quarantined'`
3. `failWorkItem` increments count and auto-quarantines at threshold 3
4. `quarantineWorkItem` sets status and reason, emits event
5. `listWorkItems` (default `status='available'`) excludes quarantined items
6. `getFailedItems` returns all failed/quarantined items ordered by `failed_at DESC`
7. Dashboard shows quarantined items table with retry button via `/api/quarantine/panel`
8. `ivy-heartbeat retry <id>` CLI command validates and requeues; also `POST /api/work-items/:id/retry`
9. 580 tests pass (90 net new); dispatch-worker calls `failWorkItem` at all 5 failure sites

The canonical failure mode from the spec (the `gh pr merge` loop — FM-1) is now addressed: after 3 failures a work item is quarantined and excluded from dispatch, terminating the loop without manual intervention.
