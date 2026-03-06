# F-033: Evaluator / Scheduler Boundary Cleanup

## Overview

The scheduler both decides WHAT to run and directly calls some evaluators synchronously. The dispatch worker handles others. The boundary is inconsistent. This refactor establishes a clean architecture: the scheduler only writes work items, the dispatch worker reads and executes them, and evaluators contain only pure logic with no direct DB writes.

**Repos affected:** `ivy-heartbeat` (scheduler.ts, dispatch-worker.ts, all evaluators)

**Dependencies:** F-028 (failure states) and F-029 (typed meta) must be implemented first

**Sprint:** 3 (Week 3+) | Priority: 6 (Architecture) | Effort: L (1 week) | Grade: C+

## Problem Statement

The current architecture has three inconsistencies:

1. **Scheduler calls evaluators directly** — `scheduler.ts` synchronously invokes some evaluators (calendar, cost-guard) while others go through the work item queue. This makes testing and reasoning harder.

2. **Evaluators write to the DB** — Some evaluators call `bb.createWorkItem()` directly inside their logic, mixing query logic with side effects.

3. **No clean boundary** — Adding a new evaluator requires modifying both `scheduler.ts` (to wire the cron) and potentially `dispatch-worker.ts` (if work-item-based), with no single "register evaluator here" location.

### Target Architecture

```
Scheduler     → writes WorkItems only → never calls evaluators directly
Dispatch Worker → reads WorkItems → calls evaluators → writes results back
Evaluators    → pure logic, return result → no direct BB writes
```

This mirrors the beads architecture: beads only tracks state, agents only execute, never mixed.

## Users & Stakeholders

- **Pipeline maintainer:** Jens-Christian — wants a codebase where adding a new evaluator is a 1-file change
- **Future agents:** Agents implementing features need clear separation to avoid cross-contamination

## User Scenarios

### Scenario 1: Adding a New Evaluator Is a 1-File Change

**Given:** Developer wants to add a new `disk-space` evaluator
**When:** They create `src/evaluators/disk-space.ts` with a `checkDiskSpace()` function
**And:** Register it in `src/evaluators/registry.ts` with a cron schedule and work item operation type
**Then:** The scheduler automatically creates work items on the cron schedule
**And:** The dispatch worker automatically routes `disk-space` items to `checkDiskSpace()`
**And:** No changes to `scheduler.ts` or `dispatch-worker.ts` are needed

### Scenario 2: Evaluator Logic Is Purely Testable

**Given:** The `calendar` evaluator function
**When:** It is called with a mock calendar response
**Then:** It returns a result object (conflicts, status) without making any DB calls
**And:** Tests can verify the logic without any blackboard connection

### Scenario 3: Scheduler Only Creates Work Items

**Given:** A heartbeat cycle triggers
**When:** `scheduler.ts` runs
**Then:** It creates work items for each due evaluator (one `calendar-check` item, one `pr-review` item, etc.)
**And:** It does NOT call any evaluator functions directly
**And:** The dispatch worker processes those items in a separate cycle

## Acceptance Criteria

1. `scheduler.ts` contains zero direct evaluator function calls
2. All evaluators moved to `src/evaluators/<name>.ts` with a consistent signature: `evaluate(context): Promise<EvaluatorResult>`
3. `src/evaluators/registry.ts` — single location to register evaluators with cron, operation type, and handler
4. `dispatch-worker.ts` routes via registry, not switch/case per operation
5. Evaluator functions make no direct `bb.*` DB calls — results returned to dispatch worker which writes
6. Existing 490 tests pass; evaluator unit tests work without blackboard connection
7. No change in external behavior (same evaluators fire, same frequency, same outcomes)

## Technical Design

### Evaluator Registry

```typescript
// src/evaluators/registry.ts
type EvaluatorDef = {
  operation: string;
  cron: string;
  handler: (context: EvaluatorContext) => Promise<EvaluatorResult>;
}

const EVALUATORS: EvaluatorDef[] = [
  { operation: 'calendar-check', cron: '*/15 * * * *', handler: checkCalendar },
  { operation: 'pr-review', cron: '*/15 * * * *', handler: reviewPR },
  { operation: 'specflow-orchestrate', cron: '*/5 * * * *', handler: orchestrateSpecflow },
  // ...
];
```

### Scheduler (simplified)

```typescript
// scheduler.ts — only creates work items
for (const evaluator of EVALUATORS) {
  if (isDue(evaluator.cron)) {
    await bb.createWorkItem({ operation: evaluator.operation, meta: {} });
  }
}
```

### Dispatch Worker (simplified)

```typescript
// dispatch-worker.ts — routes via registry
const def = EVALUATORS.find(e => e.operation === item.operation);
const result = await def.handler({ meta: item.meta, bb: bbReadonly });
await bb.completeWorkItem(item.id, result);
```

## Migration Plan

1. Extract each evaluator to `src/evaluators/<name>.ts` (no behavior change, just file move)
2. Add registry with existing entries
3. Update scheduler to create work items via registry (stop direct calls)
4. Update dispatch worker to route via registry
5. Delete the direct-call code paths from scheduler
6. Run full test suite

## Out of Scope

- Changing evaluator behavior (pure refactor)
- Adding new evaluators (done in separate features)
- Changing cron schedules
