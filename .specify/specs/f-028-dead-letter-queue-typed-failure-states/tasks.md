# Implementation Tasks: dead-letter-queue-typed-failure-states

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | ☐ | Schema migration v7 |
| T-1.2 | ☐ | Type definitions |
| T-2.1 | ☐ | failWorkItem API |
| T-2.2 | ☐ | quarantineWorkItem API |
| T-2.3 | ☐ | getFailedItems API |
| T-2.4 | ☐ | retryWorkItem API |
| T-3.1 | ☐ | Blackboard wrapper |
| T-4.1 | ☐ | Dispatch worker failure tracking |
| T-4.2 | ☐ | Scheduler failure tracking |
| T-5.1 | ☐ | CLI retry command |
| T-6.1 | ☐ | API endpoint |
| T-6.2 | ☐ | Dashboard UI |
| T-7.1 | ☐ | Unit tests for API functions |
| T-7.2 | ☐ | Integration test: 3-failure quarantine policy |

---

## Group 1: Foundation (ivy-blackboard schema + types)

### T-1.1: Schema migration v7 [T]
- **File:** `/Users/fischer/work/ivy-blackboard/src/schema.ts`
- **Test:** existing migration tests (verify `CURRENT_SCHEMA_VERSION` = 7)
- **Dependencies:** none
- **Description:**
  - Add `MIGRATE_V7_SQL` constant using table-recreation pattern (same as v5)
  - Recreate `work_items` with three new columns: `failure_count INTEGER NOT NULL DEFAULT 0`, `failure_reason TEXT`, `failed_at TEXT`
  - Extend `status` CHECK constraint to include `'failed'` and `'quarantined'`
  - INSERT-SELECT from old table with explicit `0 AS failure_count, NULL AS failure_reason, NULL AS failed_at`
  - Recreate all four indexes after table rename
  - Bump `CURRENT_SCHEMA_VERSION` from 6 to 7
  - Add seed entry for v7 in `SEED_VERSION_SQL`

  Migration SQL skeleton:
  ```sql
  PRAGMA foreign_keys = OFF;
  CREATE TABLE work_items_v7 (
    item_id TEXT PRIMARY KEY,
    -- ... all existing columns ...,
    status TEXT NOT NULL DEFAULT 'available'
      CHECK (status IN ('available','claimed','completed','blocked','waiting_for_response','failed','quarantined')),
    failure_count INTEGER NOT NULL DEFAULT 0,
    failure_reason TEXT,
    failed_at TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(project_id),
    FOREIGN KEY (claimed_by) REFERENCES agents(session_id)
  );
  INSERT INTO work_items_v7 SELECT ..., 0, NULL, NULL FROM work_items;
  DROP TABLE work_items;
  ALTER TABLE work_items_v7 RENAME TO work_items;
  CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
  CREATE INDEX IF NOT EXISTS idx_work_items_project ON work_items(project_id);
  CREATE INDEX IF NOT EXISTS idx_work_items_claimed_by ON work_items(claimed_by);
  CREATE INDEX IF NOT EXISTS idx_work_items_priority ON work_items(priority, status);
  PRAGMA foreign_keys = ON;
  ```

### T-1.2: Type definitions [T] [P with T-1.1]
- **File:** `/Users/fischer/work/ivy-blackboard/src/types.ts`
- **Dependencies:** none (can run parallel with T-1.1; T-2.x depends on both)
- **Description:**
  - Add `failure_count: number`, `failure_reason: string | null`, `failed_at: string | null` to `BlackboardWorkItem` interface
  - Add `'failed'` and `'quarantined'` to `WORK_ITEM_STATUSES` array (and the derived union type)
  - Add new event type constants: `'work_failed'`, `'work_quarantined'`, `'work_retried'` to `KNOWN_EVENT_TYPES`
  - Add result interfaces: `FailWorkItemResult`, `QuarantineWorkItemResult`, `RetryWorkItemResult`

---

## Group 2: API Functions (ivy-blackboard/src/work.ts)

### T-2.1: Implement failWorkItem [T]
- **File:** `/Users/fischer/work/ivy-blackboard/src/work.ts`
- **Test:** `/Users/fischer/work/ivy-blackboard/src/work.test.ts`
- **Dependencies:** T-1.1, T-1.2
- **Description:**
  - Add `failWorkItem(db: Database, itemId: string, reason: string): FailWorkItemResult`
  - In a transaction: `UPDATE work_items SET status = 'failed', failure_count = failure_count + 1, failed_at = ? WHERE item_id = ?`
  - Insert `work_failed` event into `events` table with `summary = reason`
  - Return `{ item_id, failure_count, status: 'failed', failed_at }`
  - Throw `WORK_ITEM_NOT_FOUND` if item doesn't exist

### T-2.2: Implement quarantineWorkItem [T] [P with T-2.1]
- **File:** `/Users/fischer/work/ivy-blackboard/src/work.ts`
- **Test:** `/Users/fischer/work/ivy-blackboard/src/work.test.ts`
- **Dependencies:** T-1.1, T-1.2
- **Description:**
  - Add `quarantineWorkItem(db: Database, itemId: string, reason: string): QuarantineWorkItemResult`
  - In a transaction: `UPDATE work_items SET status = 'quarantined', failure_reason = ? WHERE item_id = ?`
  - Insert `work_quarantined` event into `events` table
  - Return `{ item_id, quarantined: true, failure_reason: reason }`
  - Throw `WORK_ITEM_NOT_FOUND` if item doesn't exist

### T-2.3: Implement getFailedItems [T] [P with T-2.1, T-2.2]
- **File:** `/Users/fischer/work/ivy-blackboard/src/work.ts`
- **Test:** `/Users/fischer/work/ivy-blackboard/src/work.test.ts`
- **Dependencies:** T-1.1, T-1.2
- **Description:**
  - Add `getFailedItems(db: Database): BlackboardWorkItem[]`
  - `SELECT * FROM work_items WHERE status IN ('failed', 'quarantined') ORDER BY failed_at DESC`
  - Map raw rows to `BlackboardWorkItem` (same mapping as `listWorkItems`)

### T-2.4: Implement retryWorkItem [T] [P with T-2.1, T-2.2, T-2.3]
- **File:** `/Users/fischer/work/ivy-blackboard/src/work.ts`
- **Test:** `/Users/fischer/work/ivy-blackboard/src/work.test.ts`
- **Dependencies:** T-1.1, T-1.2
- **Description:**
  - Add `retryWorkItem(db: Database, itemId: string): RetryWorkItemResult`
  - Validate item exists — throw `WORK_ITEM_NOT_FOUND` if not
  - Validate `status === 'quarantined'` — throw `NOT_QUARANTINED` error if not
  - In a transaction: `UPDATE work_items SET status = 'available', failure_count = 0, failure_reason = NULL, failed_at = NULL, claimed_by = NULL, claimed_at = NULL WHERE item_id = ?`
  - Insert `work_retried` event with summary `"Manually retried by operator"`
  - Return `{ item_id, retried: true, previous_failure_count }`

---

## Group 3: Blackboard Wrapper (ivy-heartbeat)

### T-3.1: Expose new API in Blackboard class [T]
- **File:** `/Users/fischer/work/ivy-heartbeat/src/blackboard.ts`
- **Dependencies:** T-2.1, T-2.2, T-2.3, T-2.4
- **Description:**
  - Import `failWorkItem`, `quarantineWorkItem`, `getFailedItems`, `retryWorkItem` from `ivy-blackboard/src/work`
  - Add four wrapper methods to the `Blackboard` class, passing `this.db` as the first argument:
    - `failWorkItem(itemId: string, reason: string): FailWorkItemResult`
    - `quarantineWorkItem(itemId: string, reason: string): QuarantineWorkItemResult`
    - `getFailedItems(): BlackboardWorkItem[]`
    - `retryWorkItem(itemId: string): RetryWorkItemResult`

---

## Group 4: Dispatch Worker Integration (ivy-heartbeat)

### T-4.1: Add failure tracking to dispatch-worker [T]
- **File:** `/Users/fischer/work/ivy-heartbeat/src/commands/dispatch-worker.ts`
- **Dependencies:** T-3.1
- **Description:**
  - Define `const QUARANTINE_THRESHOLD = 3` at module level
  - Audit all error paths in the main dispatch loop — find the top-level `try/catch` around work item execution
  - In the `catch` block, after logging the error:
    ```typescript
    const reason = err instanceof Error ? err.message : String(err);
    const failResult = bb.failWorkItem(item.item_id, reason);
    if (failResult.failure_count >= QUARANTINE_THRESHOLD) {
      bb.quarantineWorkItem(
        item.item_id,
        `Failed ${failResult.failure_count} times. Last error: ${reason}`
      );
      console.error(`[dispatch] Quarantined ${item.item_id} after ${QUARANTINE_THRESHOLD} failures`);
    } else {
      console.error(`[dispatch] Failed ${item.item_id} (attempt ${failResult.failure_count}/${QUARANTINE_THRESHOLD}): ${reason}`);
    }
    ```
  - Confirm that the work item fetch query only returns `status = 'available'` items (verify `failed`/`quarantined` are already excluded)
  - Do NOT re-dispatch `failed` items automatically — they stay failed until manual retry

### T-4.2: Add failure tracking to scheduler [T] [P with T-4.1]
- **File:** `/Users/fischer/work/ivy-heartbeat/src/scheduler/scheduler.ts`
- **Dependencies:** T-3.1
- **Description:**
  - Same `QUARANTINE_THRESHOLD = 3` constant and catch-block pattern as T-4.1
  - Apply to the scheduler's work item dispatch loop catch block
  - Verify that the scheduler's item query also excludes `failed`/`quarantined` by default

---

## Group 5: CLI Retry Command (ivy-heartbeat)

### T-5.1: Create retry command [T]
- **File (new):** `/Users/fischer/work/ivy-heartbeat/src/commands/retry.ts`
- **File (modify):** `/Users/fischer/work/ivy-heartbeat/src/cli.ts`
- **Dependencies:** T-3.1
- **Description:**
  - Create `retry.ts` with `registerRetryCommand(program, getContext)`:
    ```typescript
    program
      .command('retry <item-id>')
      .description('Reset a quarantined work item to available for re-dispatch')
      .action((itemId: string) => {
        const { bb } = getContext();
        try {
          const result = bb.retryWorkItem(itemId);
          console.log(`Retried work item ${itemId}. Previous failure count: ${result.previous_failure_count}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Error: ${msg}`);
          process.exit(1);
        }
      });
  ```
  - Register in `cli.ts`: import and call `registerRetryCommand(program, getContext)` alongside other command registrations

---

## Group 6: Dashboard (ivy-heartbeat)

### T-6.1: Add /api/work-items/quarantined endpoint [T] [P with T-6.2]
- **File:** `/Users/fischer/work/ivy-heartbeat/src/serve/server.ts`
- **Dependencies:** T-3.1
- **Description:**
  - Add a route handler for `GET /api/work-items/quarantined`:
    ```typescript
    if (path === '/api/work-items/quarantined') {
      const items = bb.getFailedItems();
      return Response.json(items, { headers });
    }
    ```
  - Place it alongside the other `/api/work-items/...` routes
  - Use the same `headers` (CORS etc.) as existing JSON routes

### T-6.2: Add quarantined panel to dashboard [P with T-6.1]
- **File:** `/Users/fischer/work/ivy-heartbeat/src/serve/dashboard.ts`
- **Dependencies:** T-3.1 (dashboard is client-side; T-6.1 must be done for the JS fetch to work)
- **Description:**
  - Add a "Quarantined Work Items" `<section>` to `generateDashboardHTML()` (or equivalent render function)
  - HTML structure:
    ```html
    <section>
      <h2>Quarantined Work Items</h2>
      <div id="quarantined"><p class="muted">Loading...</p></div>
    </section>
    ```
  - Add `loadQuarantined()` function in the inline `<script>`:
    - Fetches `/api/work-items/quarantined`
    - Renders a table with columns: ID (first 12 chars), Title, Failures, Reason (truncated), Failed At (relative time)
    - If empty: shows "No quarantined items."
  - Call `loadQuarantined()` alongside other panel loaders in the dashboard init

---

## Group 7: Tests

### T-7.1: Unit tests for work.ts API functions [T]
- **File:** `/Users/fischer/work/ivy-blackboard/src/work.test.ts` (add to existing or create)
- **Dependencies:** T-2.1, T-2.2, T-2.3, T-2.4
- **Description:** Test each function in isolation with an in-memory SQLite DB:
  1. `failWorkItem` increments `failure_count` from 0 to 1, sets `status = 'failed'`, sets `failed_at`
  2. `failWorkItem` called twice increments to 2
  3. `failWorkItem` throws `WORK_ITEM_NOT_FOUND` for unknown ID
  4. `quarantineWorkItem` sets `status = 'quarantined'` and `failure_reason`
  5. `quarantineWorkItem` throws `WORK_ITEM_NOT_FOUND` for unknown ID
  6. `getFailedItems` returns items with status `'failed'` and `'quarantined'`, ordered by `failed_at DESC`
  7. `getFailedItems` returns empty array when no failed items
  8. `retryWorkItem` resets `failure_count = 0`, `status = 'available'`, clears `failure_reason`/`failed_at`
  9. `retryWorkItem` throws `NOT_QUARANTINED` for item with status `'available'`
  10. `listWorkItems()` (default/available filter) does NOT return `failed` or `quarantined` items

### T-7.2: Integration test — 3-failure quarantine policy [T]
- **File:** `/Users/fischer/work/ivy-heartbeat/src/commands/dispatch-worker.test.ts` (add to existing or create)
- **Dependencies:** T-4.1, T-4.2, T-7.1
- **Description:** Test the dispatch worker quarantine policy end-to-end:
  1. Item fails once → `failure_count = 1`, `status = 'failed'`, NOT quarantined
  2. Item fails twice → `failure_count = 2`, `status = 'failed'`, NOT quarantined
  3. Item fails third time → `failure_count = 3`, `status = 'quarantined'`, `failure_reason` set
  4. Quarantined item not returned by next dispatch cycle fetch
  5. Successful run after 1 failure: `failure_count` stays 1, status becomes `'completed'` (not quarantined)

---

## Execution Order

```
Phase 1 (no deps — run in parallel):
  T-1.1  Schema migration v7
  T-1.2  Type definitions

Phase 2 (after Phase 1 — T-2.x can all run in parallel):
  T-2.1  failWorkItem
  T-2.2  quarantineWorkItem
  T-2.3  getFailedItems
  T-2.4  retryWorkItem

Phase 3 (after Phase 2):
  T-3.1  Blackboard wrapper

Phase 4 (after T-3.1 — T-4.x, T-5.1, T-6.x all run in parallel):
  T-4.1  Dispatch worker failure tracking
  T-4.2  Scheduler failure tracking
  T-5.1  CLI retry command
  T-6.1  API endpoint
  T-6.2  Dashboard UI

Phase 5 (after Phase 4):
  T-7.1  Unit tests (work.ts)
  T-7.2  Integration test (quarantine policy)
```

**Total tasks:** 14
**Parallelizable groups:** T-1.1/T-1.2, T-2.1/T-2.2/T-2.3/T-2.4, T-4.1/T-4.2/T-5.1/T-6.1/T-6.2, T-7.1/T-7.2
