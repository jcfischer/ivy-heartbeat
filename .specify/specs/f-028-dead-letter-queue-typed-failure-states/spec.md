# F-028: Dead Letter Queue + Typed Failure States

## Overview

Work items that fail repeatedly re-enter the dispatch queue indefinitely. There is no `failed` state, no failure count, and no quarantine mechanism. This feature adds typed failure states to `ivy-blackboard` work items: after 3 failures, a work item is quarantined and never re-dispatched. A dashboard query and manual retry command complete the feature.

**Repos affected:** `ivy-blackboard` (schema + API), `ivy-heartbeat` (failure tracking in scheduler/dispatch-worker)

**Sprint:** 1 (Week 1) | Priority: 1 (Critical) | Effort: S (1-2 days) | Grade: A

## Problem Statement

The merge-fix loop (issue #41) is the canonical failure: a transient `gh pr merge` failure creates a merge-fix work item, which also fails, and the loop never terminates. The blackboard has no:

- `failure_count` field to count dispatch attempts
- `failed` or `quarantined` status to stop re-dispatch
- `failure_reason` to capture what went wrong
- Dashboard view of quarantined items
- Manual retry mechanism to requeue after investigation

### Failure Mode Catalog

| ID | Symptom | Root Cause |
|----|---------|-----------|
| FM-1 | Work item loops forever on transient error | No failure count or quarantine state |
| FM-2 | No visibility into why item failed | No `failure_reason` field |
| FM-3 | Operator can't manually retry after investigation | No retry command |
| FM-4 | All failures look the same | No typed failure taxonomy |

## Users & Stakeholders

- **Primary user:** PAI operator (Jens-Christian) — wants the pipeline to self-limit on failures without manual intervention
- **Pipeline maintainer:** Jens-Christian — wants clear failure visibility in the dashboard

## User Scenarios

### Scenario 1: Transient Failure → Quarantine After 3 Attempts

**Given:** A `pr-merge` work item exists with `failure_count = 2`
**When:** The dispatch worker runs it and `gh pr merge` fails again
**Then:** `failWorkItem(itemId, reason)` increments `failure_count` to 3
**And:** `quarantineWorkItem(itemId, reason)` sets status to `quarantined`
**And:** The item is never returned by `listWorkItems({status: 'pending'})` again
**And:** `getFailedItems()` returns this item with `failure_reason = "gh pr merge failed 3 times"`

### Scenario 2: Dashboard Shows Quarantined Items

**Given:** 2 work items are quarantined with failure reasons
**When:** The operator opens the dashboard
**Then:** A "Quarantined" section shows both items with IDs, titles, failure counts, and reasons

### Scenario 3: Manual Retry

**Given:** A quarantined item `witem-abc123` has been investigated and the operator believes it can succeed
**When:** The operator runs `ivy-heartbeat retry witem-abc123`
**Then:** The item's status is reset to `pending`, `failure_count` reset to 0
**And:** It re-enters the dispatch queue on the next cycle

### Scenario 4: Successful Retry Does Not Increment Failure Count

**Given:** A work item has `failure_count = 1` from a previous transient error
**When:** The dispatch worker runs it and it succeeds
**Then:** `failure_count` remains 1, status = `completed`
**And:** The item is never quarantined (failure count only matters when it fails again)

## Acceptance Criteria

1. `work_items` table gains `failure_count INTEGER DEFAULT 0`, `failure_reason TEXT`, `failed_at DATETIME`, and status gains `'failed'` and `'quarantined'` variants
2. `failWorkItem(itemId: string, reason: string): void` — increments `failure_count`, sets `failed_at`, sets status to `failed`
3. `quarantineWorkItem(itemId: string, reason: string): void` — sets status to `quarantined`, sets `failure_reason`
4. Policy in dispatch-worker: after 3rd failure, automatically call `quarantineWorkItem`
5. `getFailedItems(): WorkItem[]` — returns all quarantined items
6. `listWorkItems({status: 'pending'})` excludes `quarantined` items
7. Dashboard shows quarantined items with failure details
8. `ivy-heartbeat retry <item-id>` CLI command resets item to pending
9. Existing 490 tests pass; new tests cover the 3-failure quarantine policy

## Technical Design

### Schema (ivy-blackboard)

```sql
ALTER TABLE work_items ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_items ADD COLUMN failure_reason TEXT;
ALTER TABLE work_items ADD COLUMN failed_at DATETIME;
-- status: extend to include 'failed' | 'quarantined'
```

### API (ivy-blackboard)

```typescript
failWorkItem(itemId: string, reason: string): void
  // status = 'failed', failure_count++, failed_at = now()

quarantineWorkItem(itemId: string, reason: string): void
  // status = 'quarantined', failure_reason = reason

getFailedItems(): WorkItem[]
  // SELECT * WHERE status IN ('failed', 'quarantined')
```

### Dispatch Worker Policy (ivy-heartbeat)

```typescript
// After any work item fails:
bb.failWorkItem(itemId, errorMessage);
if (item.failureCount + 1 >= 3) {
  bb.quarantineWorkItem(itemId, `Failed ${3} times: ${errorMessage}`);
}
```

## Out of Scope

- Automatic retry with backoff (manual retry only for now)
- Failure type taxonomy beyond `failure_reason` text
- Email/Slack alerts on quarantine (F-030 agent memory covers deduplication)
