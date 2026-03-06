# F-029: Typed WorkItem Metadata + Structured Handoffs

## Overview

Work item `meta` is an untyped JSON blob. Each evaluator interprets it differently with no compile-time guarantees. This is the structural gap behind issues #39 (source filter bug), #40 (blocking issues lost), and #44 (cross-cycle data loss). This feature introduces typed meta variants (one per operation), runtime validation at work item creation, and adds `parent_event_id` to enable causal chain tracing.

**Repos affected:** `ivy-blackboard` (typed meta schema + validation), `ivy-heartbeat` (all evaluators updated to typed meta)

**Sprint:** 2 (Week 2) | Priority: 2 (High) | Effort: M (3-4 days) | Grade: A

## Problem Statement

The `meta` field is a `TEXT` column storing arbitrary JSON. When the github-issues evaluator creates a PR review work item, it populates certain fields. When the dispatch worker reads that item, it assumes those fields exist. There's no validation, no TypeScript type, and no guarantee. This causes:

- #39: Source filter bug — dispatch worker assumed a field that wasn't set
- #40: Blocking issues lost — `blockingIssues` array dropped between phases
- #44: Cross-cycle data loss — data present in cycle 1 absent in cycle 2

Beads uses a `discovered-from` relationship type to enforce typed provenance between parent and child issues. This feature implements the equivalent pattern in ivy-blackboard.

### Failure Mode Catalog

| ID | Symptom | Root Cause |
|----|---------|-----------|
| FM-1 | Runtime error reading undefined field | No schema enforcement at creation |
| FM-2 | Downstream evaluator gets wrong field names | Different evaluators use different key names |
| FM-3 | No causal chain tracing | No parent_event_id linking work items |
| FM-4 | TypeScript can't catch handoff bugs | `meta: Record<string, unknown>` type |

## Users & Stakeholders

- **Primary user:** PAI operator (Jens-Christian) — wants cross-cycle data stability
- **Pipeline maintainer:** Jens-Christian — wants TypeScript compile errors when meta schemas mismatch

## User Scenarios

### Scenario 1: Schema Mismatch Caught at Compile Time

**Given:** Developer adds a new field `repoOwner` to `PRReviewMeta` in ivy-blackboard
**When:** The dispatch worker tries to access `meta.repoOwner` on a `SpecFlowMeta` item
**Then:** TypeScript reports a type error: `Property 'repoOwner' does not exist on type 'SpecFlowMeta'`
**And:** The bug is caught before deployment

### Scenario 2: Runtime Validation at Work Item Creation

**Given:** The github-issues evaluator tries to create a `pr-review` work item without the required `prNumber` field
**When:** `bb.createWorkItem({ operation: 'pr-review', meta: { prUrl: '...' } })` is called
**Then:** `validateMeta('pr-review', meta)` throws: `"Missing required field: prNumber"`
**And:** The work item is not created

### Scenario 3: Causal Chain Tracing

**Given:** A `pr-review` work item was created as a result of event `evt-abc123`
**When:** The work item is created with `parentEventId: 'evt-abc123'`
**Then:** The dashboard can display: check → alert event → pr-review work item → outcome
**And:** Any child work items (merge, rework) link back to the original event

### Scenario 4: Blocking Issues Persist Across Review Cycles

**Given:** Review cycle 1 identifies 3 blocking issues stored in `PRReviewMeta.blockingIssues`
**When:** Rework completes and a new pr-review work item is created for cycle 2
**Then:** `blockingIssues` from cycle 1 is passed forward in the new work item's meta
**And:** The review agent can see "these issues were flagged in the previous cycle"

## Acceptance Criteria

1. TypeScript discriminated union: `type WorkItemMeta = SpecFlowMeta | PRReviewMeta | MergeMeta | ...`
2. Runtime validation function: `validateMeta(operation: string, meta: unknown): asserts meta is WorkItemMeta`
3. `createWorkItem` calls `validateMeta` and throws on schema mismatch
4. `parent_event_id TEXT` column added to `work_items` table
5. `parent_event_id` exposed in `CreateWorkItemOptions` and `WorkItem` types
6. All existing evaluators updated to use typed meta variants (no `Record<string, unknown>`)
7. `PRReviewMeta.blockingIssues: BlockingIssue[]` field persisted and forwarded to next cycle
8. Existing 490 tests pass; new tests cover schema validation rejection and parent_event_id
9. TypeScript compilation catches wrong-type meta access at compile time (verified via `tsc --noEmit`)

## Technical Design

### Typed Meta Variants (ivy-blackboard)

```typescript
type SpecFlowMeta = {
  featureId: string;
  phase: SpecFlowPhase;
  specPath: string;
  worktreePath?: string;
}

type PRReviewMeta = {
  prNumber: number;
  prUrl: string;
  repoOwner: string;
  repoName: string;
  headBranch: string;
  blockingIssues: BlockingIssue[];
}

type MergeMeta = {
  prNumber: number;
  prUrl: string;
  mergeStrategy: 'squash' | 'merge' | 'rebase';
  retryCount: number;
}

type WorkItemMeta = SpecFlowMeta | PRReviewMeta | MergeMeta | CalendarMeta;
```

### Schema Addition (ivy-blackboard)

```sql
ALTER TABLE work_items ADD COLUMN parent_event_id TEXT REFERENCES events(id);
```

### Validation (ivy-blackboard)

```typescript
function validateMeta(operation: string, meta: unknown): asserts meta is WorkItemMeta {
  const schema = META_SCHEMAS[operation];
  if (!schema) throw new Error(`Unknown operation: ${operation}`);
  schema.parse(meta); // Zod parse, throws on failure
}
```

## Migration Strategy

Existing work items have untyped meta. The migration is additive:
- Old items get `meta_type = 'legacy'` and bypass new validation
- Only newly created items use the typed schema
- Evaluators can be migrated one at a time (legacy items remain readable)

## Out of Scope

- Migrating all existing work items to typed meta (legacy items bypass validation)
- Full audit trail UI for causal chains (parent_event_id stored; dashboard link is stretch goal)
