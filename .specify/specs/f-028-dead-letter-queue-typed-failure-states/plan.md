# Technical Plan: dead-letter-queue-typed-failure-states

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  ivy-blackboard (schema + API)                                   │
│                                                                  │
│  work_items table                                                │
│  ┌────────────────────────────────────────────┐                 │
│  │ + failure_count  INTEGER DEFAULT 0          │                 │
│  │ + failure_reason TEXT                       │                 │
│  │ + failed_at      DATETIME                   │                 │
│  │ status: + 'failed' | 'quarantined'          │                 │
│  └────────────────────────────────────────────┘                 │
│                                                                  │
│  work.ts (new functions)                                         │
│  ┌──────────────────────────────────┐                           │
│  │ failWorkItem(id, reason)         │                           │
│  │ quarantineWorkItem(id, reason)   │                           │
│  │ getFailedItems()                 │                           │
│  │ retryWorkItem(id)                │                           │
│  └──────────────────────────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
         ▲                                    ▲
         │                                    │
┌────────┴────────────┐          ┌────────────┴──────────────────┐
│  ivy-heartbeat       │          │  ivy-heartbeat                 │
│  blackboard.ts       │          │  commands/dispatch-worker.ts   │
│  (expose new API)    │          │  scheduler/scheduler.ts        │
│                      │          │                                │
│  commands/retry.ts   │          │  On catch:                     │
│  ivy-heartbeat retry │          │   bb.failWorkItem(id, err)    │
│    <item-id>         │          │   if count >= 3:               │
│                      │          │     bb.quarantineWorkItem()    │
└──────────────────────┘          └────────────────────────────────┘
         │
         ▼
┌──────────────────────────────────────┐
│  Dashboard (serve/server.ts)          │
│  GET /api/work-items/quarantined      │
│  serve/views/quarantine-panel.ts      │
└──────────────────────────────────────┘
```

**Key constraint:** SQLite cannot `ALTER TABLE` to change a CHECK constraint. Adding `failed` and `quarantined` to the `status` column requires a table-recreation migration — the same pattern used in v4 (source constraint) and v5 (waiting_for_response). This is migration **v7**.

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Project standard |
| Database | SQLite via `bun:sqlite` | Existing infrastructure |
| Migration | Table-recreation pattern | SQLite constraint limitation (same as v4, v5) |
| CLI | Commander.js | Existing pattern in `commands/` |
| Dashboard | Inline HTML/JS in existing panel | Matches `serve/views/specflow-panel.ts` pattern |

## Data Model

### Schema Changes (migration v7)

The `work_items` table must be recreated to extend the `status` CHECK constraint. Three new columns are added during recreation.

```sql
-- work_items_v7 (full table definition after migration)
CREATE TABLE work_items_v7 (
    item_id        TEXT PRIMARY KEY,
    project_id     TEXT,
    title          TEXT NOT NULL,
    description    TEXT,
    source         TEXT NOT NULL,
    source_ref     TEXT,
    status         TEXT NOT NULL DEFAULT 'available'
                   CHECK (status IN (
                     'available', 'claimed', 'completed',
                     'blocked', 'waiting_for_response',
                     'failed', 'quarantined'          -- NEW
                   )),
    priority       TEXT DEFAULT 'P2'
                   CHECK (priority IN ('P1', 'P2', 'P3')),
    claimed_by     TEXT,
    claimed_at     TEXT,
    completed_at   TEXT,
    blocked_by     TEXT,
    created_at     TEXT NOT NULL,
    metadata       TEXT,
    failure_count  INTEGER NOT NULL DEFAULT 0,  -- NEW
    failure_reason TEXT,                         -- NEW
    failed_at      TEXT,                         -- NEW (ISO 8601)

    FOREIGN KEY (project_id) REFERENCES projects(project_id),
    FOREIGN KEY (claimed_by) REFERENCES agents(session_id)
);
```

### Updated TypeScript Interface

```typescript
// ivy-blackboard/src/types.ts — BlackboardWorkItem additions
export interface BlackboardWorkItem {
  // ... existing fields unchanged ...
  failure_count: number;        // NEW — number of dispatch attempts that failed
  failure_reason: string | null; // NEW — last failure message / quarantine reason
  failed_at: string | null;     // NEW — ISO 8601 timestamp of most recent failure
}

// Updated status union
export const WORK_ITEM_STATUSES = [
  "available",
  "claimed",
  "completed",
  "blocked",
  "waiting_for_response",
  "failed",       // NEW — failed once or twice, will be re-dispatched
  "quarantined",  // NEW — failed 3+ times, never re-dispatched
] as const;
```

**Status semantics:**
- `available` — ready for dispatch
- `claimed` — currently being processed by an agent
- `failed` — last run failed; failure_count < 3; will return to `available` on next dispatch cycle
- `quarantined` — failure_count >= 3; permanently excluded from dispatch
- `completed` — finished successfully
- `blocked` — manually blocked by operator
- `waiting_for_response` — blocked on external dependency

## API Contracts

### New functions in `ivy-blackboard/src/work.ts`

```typescript
/**
 * Record a failure for a work item.
 * Increments failure_count, sets failed_at, status = 'failed'.
 * Does NOT quarantine — caller decides whether to quarantine.
 * Works on items in any non-completed status.
 */
export function failWorkItem(
  db: Database,
  itemId: string,
  reason: string
): FailWorkItemResult

export interface FailWorkItemResult {
  item_id: string;
  failure_count: number;   // new value after increment
  status: string;          // 'failed'
  failed_at: string;       // ISO 8601
}

/**
 * Quarantine a work item — permanent stop.
 * Sets status = 'quarantined', failure_reason = reason.
 * Emits 'work_quarantined' event.
 * Must be called AFTER failWorkItem (failure_count already incremented).
 */
export function quarantineWorkItem(
  db: Database,
  itemId: string,
  reason: string
): QuarantineWorkItemResult

export interface QuarantineWorkItemResult {
  item_id: string;
  quarantined: boolean;
  failure_reason: string;
}

/**
 * Return all quarantined (or failed) work items.
 * Ordered by failed_at DESC.
 */
export function getFailedItems(db: Database): BlackboardWorkItem[]

/**
 * Reset a quarantined item back to available for retry.
 * Resets: status = 'available', failure_count = 0, failure_reason = NULL,
 *         failed_at = NULL, claimed_by = NULL, claimed_at = NULL.
 * Emits a 'work_released' event with summary "Manually retried by operator".
 * Throws WORK_ITEM_NOT_FOUND if not found.
 * Throws NOT_QUARANTINED if status != 'quarantined'.
 */
export function retryWorkItem(
  db: Database,
  itemId: string
): RetryWorkItemResult

export interface RetryWorkItemResult {
  item_id: string;
  retried: boolean;
  previous_failure_count: number;
}
```

### New API endpoint in `ivy-heartbeat/src/serve/server.ts`

```
GET /api/work-items/quarantined
Response: BlackboardWorkItem[]
```

### New CLI command

```
ivy-heartbeat retry <item-id>

Options: none
Output: "Retried work item <id>. Previous failure count: N"
Error on non-quarantined: "Work item <id> is not quarantined (status: <status>)"
```

### Dispatch worker quarantine policy (constant)

```typescript
const MAX_FAILURES = 3; // quarantine threshold — defined in dispatch-worker.ts
```

## Implementation Phases

### Phase 1: Schema Migration (ivy-blackboard)

**Files:**
- `ivy-blackboard/src/schema.ts`
- `ivy-blackboard/src/types.ts`

**Steps:**
1. Add `MIGRATE_V7_SQL` constant — table-recreation with new columns + extended CHECK
2. Bump `CURRENT_SCHEMA_VERSION` from 6 to 7
3. Add seed entry for v7 to `SEED_VERSION_SQL`
4. Update `BlackboardWorkItem` interface: add `failure_count`, `failure_reason`, `failed_at`
5. Update `WORK_ITEM_STATUSES`: add `'failed'` and `'quarantined'`

**Migration SQL pattern** (same as v5):
```sql
PRAGMA foreign_keys = OFF;
CREATE TABLE work_items_v7 ( ... );
INSERT INTO work_items_v7 SELECT
  item_id, project_id, title, description, source, source_ref,
  status, priority, claimed_by, claimed_at, completed_at, blocked_by,
  created_at, metadata,
  0 AS failure_count, NULL AS failure_reason, NULL AS failed_at
FROM work_items;
DROP TABLE work_items;
ALTER TABLE work_items_v7 RENAME TO work_items;
CREATE INDEX IF NOT EXISTS idx_work_items_status   ON work_items(status);
CREATE INDEX IF NOT EXISTS idx_work_items_project  ON work_items(project_id);
CREATE INDEX IF NOT EXISTS idx_work_items_claimed_by ON work_items(claimed_by);
CREATE INDEX IF NOT EXISTS idx_work_items_priority ON work_items(priority, status);
PRAGMA foreign_keys = ON;
```

### Phase 2: API Functions (ivy-blackboard)

**File:** `ivy-blackboard/src/work.ts`

**Steps:**
1. Add `failWorkItem(db, itemId, reason)` — transaction: UPDATE + INSERT event
2. Add `quarantineWorkItem(db, itemId, reason)` — transaction: UPDATE + INSERT event
3. Add `getFailedItems(db)` — SELECT WHERE status IN ('failed', 'quarantined')
4. Add `retryWorkItem(db, itemId)` — transaction: validate quarantined, UPDATE reset, INSERT event
5. Update `listWorkItems`: the existing validation loop checks against `WORK_ITEM_STATUSES` — this will automatically allow filtering by `'failed'` and `'quarantined'` once the type is updated in Phase 1
6. Add new event types to `KNOWN_EVENT_TYPES` in `types.ts`: `'work_failed'`, `'work_quarantined'`, `'work_retried'`

### Phase 3: Blackboard Wrapper (ivy-heartbeat)

**File:** `ivy-heartbeat/src/blackboard.ts`

**Steps:**
1. Import `failWorkItem`, `quarantineWorkItem`, `getFailedItems`, `retryWorkItem` from `ivy-blackboard/src/work`
2. Add wrapper methods to `Blackboard` class:
   - `failWorkItem(itemId, reason)`
   - `quarantineWorkItem(itemId, reason)`
   - `getFailedItems()`
   - `retryWorkItem(itemId)`

### Phase 4: Dispatch Worker Integration (ivy-heartbeat)

**Files:**
- `ivy-heartbeat/src/commands/dispatch-worker.ts` — main dispatch loop
- `ivy-heartbeat/src/scheduler/scheduler.ts` — scheduler dispatch loop

**Steps:**

In both files, identify the top-level `try/catch` around work item execution and add failure tracking:

```typescript
const QUARANTINE_THRESHOLD = 3;

// After catching a work item execution error:
try {
  // ... run work item ...
} catch (err: unknown) {
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
}
```

**Note:** Items in `failed` status must NOT be re-dispatched. Update the work item query in both dispatch loops to exclude `failed` and `quarantined`:

The existing `listWorkItems` default already filters `status = 'available'`. The dispatch loops call `bb.listWorkItems()` without arguments, so `failed` and `quarantined` items are **automatically excluded** — no query change needed.

However: when a `failed` item needs to return to `available` for re-dispatch, that must happen explicitly. Per the spec, `failed` items stay in `failed` status until:
- They are manually retried (`ivy-heartbeat retry`) → reset to `available`
- **OR** the dispatch worker resets them before retry

**Decision:** Per spec Scenario 4 and the "no automatic retry with backoff" out-of-scope note, `failed` items do NOT automatically return to `available`. They stay in `failed` until manually retried. This simplifies the dispatch loop — no status change on failure beyond `failWorkItem` + optional `quarantineWorkItem`.

**Re-evaluation:** The spec says after 3 failures → quarantine (never re-dispatched). But items with 1-2 failures: the spec says "failure_count only matters when it fails again" (Scenario 4). The spec does NOT describe automatic re-queueing of `failed` items. Keep `failed` items out of dispatch until manual retry.

### Phase 5: CLI Retry Command (ivy-heartbeat)

**New file:** `ivy-heartbeat/src/commands/retry.ts`

```typescript
import { Command } from 'commander';
import type { CliContext } from '../cli.ts';

export function registerRetryCommand(
  program: Command,
  getContext: () => CliContext
) {
  program
    .command('retry <item-id>')
    .description('Reset a quarantined work item to available for re-dispatch')
    .action((itemId: string) => {
      const { bb } = getContext();
      const result = bb.retryWorkItem(itemId);
      console.log(`Retried work item ${itemId}. Previous failure count: ${result.previous_failure_count}`);
    });
}
```

Register in `ivy-heartbeat/src/cli.ts`:
```typescript
import { registerRetryCommand } from './commands/retry.ts';
// ...
registerRetryCommand(program, getContext);
```

### Phase 6: Dashboard (ivy-heartbeat)

**Files:**
- `ivy-heartbeat/src/serve/server.ts` — add `/api/work-items/quarantined` endpoint
- `ivy-heartbeat/src/serve/dashboard.ts` — add "Quarantined Items" section to HTML
- `ivy-heartbeat/src/serve/views/quarantine-panel.ts` — new panel view (or inline in dashboard)

**API endpoint:**
```typescript
if (path === '/api/work-items/quarantined') {
  const items = bb.getFailedItems();
  return Response.json(items, { headers });
}
```

**Dashboard HTML addition** (in `generateDashboardHTML()`):
```html
<h2>Quarantined Work Items</h2>
<div id="quarantined"><p style="color:#555;font-style:italic">Loading...</p></div>
```

**Dashboard JS addition:**
```javascript
async function loadQuarantined() {
  const items = await fetchJSON('/api/work-items/quarantined');
  const el = document.getElementById('quarantined');
  if (!items.length) {
    el.innerHTML = '<p style="color:#555;font-style:italic">No quarantined items.</p>';
    return;
  }
  el.innerHTML = `<table>
    <tr><th>ID</th><th>Title</th><th>Failures</th><th>Reason</th><th>Failed At</th></tr>
    ${items.map(i => `<tr>
      <td><code>${i.item_id.slice(0, 12)}</code></td>
      <td>${i.title}</td>
      <td class="error">${i.failure_count}</td>
      <td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${i.failure_reason ?? ''}</td>
      <td>${i.failed_at ? relTime(i.failed_at) : '—'}</td>
    </tr>`).join('')}
  </table>`;
}
```

### Phase 7: Tests (ivy-heartbeat)

**Existing test locations:** `bun test` runs 490 tests across 34 files. Add tests alongside existing work item tests.

**Test file:** `ivy-blackboard/src/work.test.ts` (or adjacent to existing work tests)

Test cases to cover:
1. `failWorkItem` increments `failure_count` and sets `failed_at`
2. After 3rd failure, dispatch worker quarantines the item
3. Quarantined items not returned by `listWorkItems()` (default available filter)
4. `getFailedItems()` returns quarantined items
5. `retryWorkItem` resets count to 0 and status to `available`
6. `retryWorkItem` throws `NOT_QUARANTINED` for non-quarantined items
7. Successful execution after 1 failure: `failure_count` remains 1, status `completed`

## File Structure

```
ivy-blackboard/
├── src/
│   ├── schema.ts          MODIFY — add MIGRATE_V7_SQL, bump version, update CREATE_TABLES_SQL
│   ├── types.ts           MODIFY — extend WORK_ITEM_STATUSES, extend BlackboardWorkItem, add event types
│   └── work.ts            MODIFY — add failWorkItem, quarantineWorkItem, getFailedItems, retryWorkItem

ivy-heartbeat/
├── src/
│   ├── blackboard.ts      MODIFY — import + wrap 4 new functions
│   ├── cli.ts             MODIFY — register retry command
│   ├── commands/
│   │   ├── dispatch-worker.ts  MODIFY — add failure tracking in catch block
│   │   └── retry.ts            CREATE — retry command handler
│   ├── scheduler/
│   │   └── scheduler.ts        MODIFY — add failure tracking in catch block
│   └── serve/
│       ├── server.ts           MODIFY — add /api/work-items/quarantined endpoint
│       └── dashboard.ts        MODIFY — add quarantined section to HTML + JS
```

## Dependencies

| Dependency | Type | Notes |
|------------|------|-------|
| `bun:sqlite` | Built-in | Already used throughout |
| `ivy-blackboard` | Internal | Already a dependency of ivy-heartbeat |
| No new npm packages | — | All functionality uses existing infrastructure |

**Prerequisites:**
- ivy-blackboard migration v7 must run before ivy-heartbeat uses new API functions
- The migration runs automatically on `openDatabase()` via the existing migration runner in `ivy-blackboard/src/db.ts`
- Both repos must be updated in the same deployment (blackboard first, heartbeat second)

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Migration v7 locks DB briefly during table recreation | Low | `PRAGMA busy_timeout = 5000` already set; scheduler retries naturally |
| Existing tests use hardcoded status values | Medium | Search test files for `'available'/'claimed'` string literals; update any list that validates against `WORK_ITEM_STATUSES` |
| Dispatch worker doesn't reach the catch block for all failure types | High | Audit all failure paths in dispatch-worker.ts and scheduler.ts — some failures may release the item before erroring; ensure `failWorkItem` is called in all error paths |
| `failed` status items silently accumulate | Low | `getFailedItems()` includes both `failed` and `quarantined`; dashboard shows both |
| SQLite INTEGER DEFAULT 0 on migration INSERT-SELECT | Low | Explicit `0 AS failure_count` in INSERT-SELECT prevents NULL violation |
| `WORK_ITEM_STATUSES` validation in `listWorkItems` rejects `'quarantined'` | Medium | Phase 1 must land before Phase 2/3 — update type array before adding `getFailedItems` which queries by those statuses |

## Implementation Order

The phases have these dependencies:

```
Phase 1 (schema + types)
  └── Phase 2 (API functions) — requires updated schema and WORK_ITEM_STATUSES
        └── Phase 3 (blackboard wrapper) — requires Phase 2 exports
              ├── Phase 4 (dispatch worker) — requires Phase 3
              ├── Phase 5 (CLI retry) — requires Phase 3
              └── Phase 6 (dashboard) — requires Phase 3
Phase 7 (tests) — can be written alongside any phase but run after all
```

Phases 4, 5, and 6 are independent of each other and can be implemented in any order once Phase 3 is complete.
