# F-031: Dependency-Aware Dispatch

## Overview

The dispatch worker grabs the oldest unclaimed pending work item regardless of dependencies. A PR merge item can run before its review is approved. A specflow implement item can run before its plan is complete. This feature adds a `depends_on` field to work items and a `listReadyWorkItems()` query that only returns items whose dependencies are all completed.

**Repos affected:** `ivy-blackboard` (schema + listReadyWorkItems), `ivy-heartbeat` (dispatch worker uses listReadyWorkItems)

**Sprint:** 2 (Week 2) | Priority: 4 (Medium) | Effort: M (2-3 days) | Grade: B+

## Problem Statement

The dispatch worker currently uses `listWorkItems({status: 'pending'})` — no dependency awareness. This means:

- A `pr-merge` item can dispatch before the `pr-review` item is approved
- SpecFlow phases are sequenced by evaluator logic and metadata (fragile), not by explicit dependencies
- No way to express "don't run X until Y succeeds"

Steve Yegge's beads flagship feature is `bd ready --json` — only returns items with all blockers resolved, traversing the full dependency graph. This feature implements the equivalent primitive.

### Failure Mode Catalog

| ID | Symptom | Root Cause |
|----|---------|-----------|
| FM-1 | PR merged before review approved | No dependency between merge and review items |
| FM-2 | Phase N+1 runs before phase N completes | Implicit sequencing via evaluator if/else chain |
| FM-3 | Dependency cycles not detected | No cycle detection at creation time |

## Users & Stakeholders

- **Primary user:** PAI operator (Jens-Christian) — wants correct ordering without manual supervision
- **Pipeline maintainer:** Jens-Christian — wants specflow phases expressed as dependencies, not evaluator logic

## User Scenarios

### Scenario 1: PR Merge Blocked Until Review Approved

**Given:** A `pr-review` work item `witem-review-48` exists for PR #48
**When:** The merge work item is created: `bb.createWorkItem({ operation: 'pr-merge', ..., dependsOn: ['witem-review-48'] })`
**And:** `witem-review-48` has status `pending` (not yet completed)
**Then:** `bb.listReadyWorkItems()` does NOT return the merge item
**When:** `witem-review-48` status changes to `completed`
**Then:** `bb.listReadyWorkItems()` now includes the merge item

### Scenario 2: SpecFlow Phase Chain via Dependencies

**Given:** Feature F-030 has plan work item `witem-plan-030` and implement work item `witem-impl-030`
**When:** The orchestrator creates the implement item with `dependsOn: ['witem-plan-030']`
**Then:** The dispatch worker never runs implement before plan completes
**And:** No evaluator if/else phase-ordering logic is needed

### Scenario 3: Cycle Detection at Creation Time

**Given:** Item A depends on item B, item B depends on item A (cycle)
**When:** `bb.createWorkItem({ dependsOn: ['witem-b'] })` is called for item A after B already depends on A
**Then:** `createWorkItem` throws: `"Dependency cycle detected: A → B → A"`
**And:** Neither item is created with the cyclic dependency

### Scenario 4: Cascading Completion

**Given:** Items C → B → A (C depends on B which depends on A)
**When:** A completes, then B dispatches and completes
**Then:** `bb.listReadyWorkItems()` now returns C for the first time
**And:** C dispatches correctly on the next cycle

## Acceptance Criteria

1. `work_items` table gains `depends_on TEXT` (JSON array of item IDs, default `'[]'`)
2. `bb.createWorkItem(opts)` accepts `dependsOn?: string[]` and stores as JSON
3. Cycle detection: `createWorkItem` traverses dependency graph and throws on cycle
4. `bb.listReadyWorkItems(): WorkItem[]` — returns pending items where all `depends_on` targets are `completed`
5. Dispatch worker updated to use `listReadyWorkItems()` instead of `listWorkItems({status:'pending'})`
6. Existing `blockWorkItem` API unchanged (different concept — blockers vs dependencies)
7. Existing 490 tests pass; new tests cover dependency blocking, cascade, cycle detection
8. Performance: `listReadyWorkItems()` executes in < 50ms for up to 1000 work items

## Technical Design

### Schema (ivy-blackboard)

```sql
ALTER TABLE work_items ADD COLUMN depends_on TEXT NOT NULL DEFAULT '[]';
-- Stores JSON array of work item IDs: '["witem-abc", "witem-def"]'
```

### API (ivy-blackboard)

```typescript
// Creation
bb.createWorkItem({
  operation: 'pr-merge',
  meta: { ... },
  dependsOn: ['witem-review-48'],  // NEW
})

// Ready query
bb.listReadyWorkItems(): WorkItem[]
  // WHERE status = 'pending'
  // AND all ids in depends_on array have status = 'completed'
  // (single SQL query with JSON_EACH + subquery)
```

### SQL Query for listReadyWorkItems

```sql
SELECT w.* FROM work_items w
WHERE w.status = 'pending'
  AND w.claimed_by IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM JSON_EACH(w.depends_on) AS dep
    WHERE (SELECT status FROM work_items WHERE id = dep.value) != 'completed'
  )
ORDER BY w.created_at ASC;
```

## Out of Scope

- Priority-based dispatch ordering (currently FIFO within ready items)
- Dependency visualization in dashboard
- Cross-project dependencies (same project only)
