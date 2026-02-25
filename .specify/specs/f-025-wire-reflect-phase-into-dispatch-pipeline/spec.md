# F-025: Wire REFLECT Phase into Dispatch Pipeline

## Overview

F-021 implemented the REFLECT phase orchestrator (`src/scheduler/reflect.ts`) and lesson extraction infrastructure, but the pipeline integration was deferred. Three critical gaps prevent the reflect phase from ever executing: (1) pr-merge.ts doesn't create reflect work items after successful merges, (2) scheduler.ts lacks the parseReflectMeta/runReflect handlers in its dispatch loop, and (3) dispatch-worker.ts lacks the same handlers for fire-and-forget mode. Additionally, the lesson CLI commands exist in `src/commands/lesson.ts` but are not registered in `src/cli.ts`, making them unusable. Without this wiring, the institutional memory loop remains open—lessons are never extracted, and future IMPLEMENT agents repeat the same mistakes.

## Problem Statement

The REFLECT phase exists as working code but is architecturally isolated from the dispatch pipeline. When a PR merges successfully, no reflect work item is created on the blackboard. Even if one were manually created, the scheduler and dispatch-worker don't recognize `reflect` as a valid work item type—they would skip it or throw an error. The result: zero lessons extracted, zero institutional memory accumulated, and the lesson CLI commands operate on an empty dataset.

**Impact:**
- F-021 is technically incomplete—the feature was built but never deployed
- Agents make the same mistakes across cycles (no learning feedback loop)
- Lesson CLI is dead code (no data to query)
- Technical debt in the dispatch pipeline (missing handler for a known work item type)

## Users & Stakeholders

- **Primary user:** PAI operator reviewing post-merge lesson curation
- **Consumer:** Future IMPLEMENT phase agents receiving injected lesson context
- **Maintainer:** SpecFlow pipeline maintainer (needs consistent handler patterns)

## User Scenarios

### Scenario 1: PR Merge Triggers Lesson Extraction

**Given:** An implementation work item has completed the review→merge cycle successfully
**When:** The PR merge handler completes
**Then:** A reflect work item is created on the blackboard with ReflectMetadata
**And:** The reflect work item contains project_id, implementation_work_item_id, pr_number, pr_url

### Scenario 2: Scheduled Dispatcher Picks Up Reflect Work Item

**Given:** A reflect work item exists on the blackboard with status "pending"
**When:** The scheduler's dispatch loop evaluates work items
**Then:** The scheduler recognizes the reflect work item type
**And:** Invokes runReflect with parsed ReflectMetadata
**And:** The reflect orchestrator extracts lessons from the completed cycle

### Scenario 3: Fire-and-Forget Worker Handles Reflect

**Given:** A reflect work item is dispatched to the fire-and-forget worker
**When:** The dispatch-worker evaluates the work item metadata
**Then:** The worker recognizes the reflect work item type
**And:** Invokes runReflect via the same code path as the scheduler
**And:** Lessons are extracted without blocking the main dispatch loop

### Scenario 4: Operator Queries Lessons via CLI

**Given:** Reflect work items have run and persisted lessons to the blackboard
**When:** The operator runs `ivy-heartbeat lesson list`
**Then:** Recent lessons are displayed with project, category, severity
**And:** The operator can run `lesson search <query>` for FTS5 search
**And:** The operator can run `lesson show <id>` for full lesson detail
**And:** The operator can run `lesson curate` for interactive curation

## Functional Requirements

### FR-1: PR Merge Creates Reflect Work Item

**Requirement:** After a successful PR merge, `src/scheduler/pr-merge.ts` must create a reflect work item on the blackboard.

**Specification:**
- Trigger: `runPRMerge()` completes successfully (PR merged, no errors)
- Work item creation: Call `blackboard.createWorkItem()` with:
  - `type: "reflect"`
  - `status: "pending"`
  - `metadata: ReflectMetadata` — see FR-8 for exact structure
- Location: After PR merge confirmation, before final status update

**Pattern Reference:** Follow the existing pattern from `src/scheduler/rework.ts` where rework work items are created after review feedback.

### FR-2: Scheduler Dispatch Loop Handles Reflect

**Requirement:** `src/scheduler/scheduler.ts` must recognize and dispatch reflect work items.

**Specification:**
- Import `parseReflectMeta` and `runReflect` from `../scheduler/reflect`
- Add conditional branch in main dispatch loop:
  ```typescript
  if (metadata.reflect === true) {
    const reflectMeta = parseReflectMeta(metadata);
    await runReflect(db, reflectMeta, spawner);
  }
  ```
- Location: In `processWorkItems()` after existing handlers (review, rework, pr-merge, merge-fix)
- Error handling: Catch parseReflectMeta validation errors, mark work item failed with error message

**Pattern Reference:** Match the existing `if (metadata.pr_merge === true)` handler structure.

### FR-3: Dispatch Worker Handles Reflect

**Requirement:** `src/commands/dispatch-worker.ts` must handle reflect work items in fire-and-forget mode.

**Specification:**
- Import `parseReflectMeta` and `runReflect` from `../scheduler/reflect`
- Add conditional branch in worker's dispatch logic (same structure as FR-2)
- Location: In the main work item processing switch/if-else block
- Heartbeat: Send heartbeat before and after runReflect (match review handler pattern)

**Pattern Reference:** The dispatch-worker should mirror the scheduler's handler structure exactly—code duplication is acceptable for consistency.

### FR-4: Lesson CLI Commands Registered

**Requirement:** The lesson command group must be registered in `src/cli.ts` so users can invoke lesson subcommands.

**Specification:**
- Import `lessonCommand` from `./commands/lesson`
- Register with Commander.js: `program.addCommand(lessonCommand)`
- Location: After existing command registrations (work, agent, project, etc.)
- Verify: `ivy-heartbeat lesson --help` shows subcommands

**Pattern Reference:** Follow the registration pattern from `workCommand`, `agentCommand`, etc.

### FR-5: Lesson Subcommands Available

**Requirement:** All four lesson subcommands must be executable via the CLI.

**Specification:**
- `lesson list [--project <name>] [--category <cat>] [--severity <level>] [--limit <n>]`
- `lesson search <query>`
- `lesson show <id>`
- `lesson curate [--project <name>] [--since <date>]`

**Implementation:** These commands already exist in `src/commands/lesson.ts`—registration (FR-4) is sufficient to make them available.

### FR-6: End-to-End Trigger Verification

**Requirement:** A successful PR merge must trigger lesson extraction without manual intervention.

**Specification:**
- Integration test or manual verification flow:
  1. Complete a specify→implement→review→merge cycle
  2. Verify reflect work item appears on blackboard with correct metadata
  3. Verify scheduler or dispatch-worker picks up the work item
  4. Verify lessons are persisted as `lesson.created` events
  5. Verify `lesson list` returns the newly extracted lessons

**Success Signal:** Lessons appear in the blackboard events table and are queryable via CLI.

### FR-7: Reflect Does Not Run Prematurely

**Requirement:** The reflect phase must NOT trigger before PR merge completion.

**Specification (anti-pattern):**
- No reflect work item creation in review.ts, rework.ts, or implement.ts
- Reflect work item creation ONLY in pr-merge.ts after successful merge
- Validation: Grep codebase for `type: "reflect"` — should only appear in pr-merge.ts

### FR-8: Metadata Type Safety

**Requirement:** Reflect work item metadata must conform to the ReflectMetadata TypeScript type.

**Specification:**
- Type contract (from `src/reflect/types.ts`):
  ```typescript
  interface ReflectMetadata {
    reflect: true;
    project_id: string;
    implementation_work_item_id: string;
    pr_number: number;
    pr_url: string;
  }
  ```
- pr-merge.ts must construct metadata with these exact field names and types
- parseReflectMeta() will validate and throw if any field is missing/incorrect
- Static verification: TypeScript compilation passes

## Non-Functional Requirements

### NFR-1: Handler Pattern Consistency

The reflect handlers in scheduler.ts and dispatch-worker.ts must follow the same structural pattern as existing handlers (review, rework, pr-merge, merge-fix). This ensures maintainability and reduces cognitive load when reading the dispatch loop.

**Pattern Elements:**
- Metadata parsing function (`parseXMeta`)
- Handler invocation function (`runX`)
- Conditional branch: `if (metadata.x === true)`
- Error handling: catch, log, mark work item failed
- Heartbeat events before/after handler (dispatch-worker only)

### NFR-2: Zero Behavioral Change to Existing Phases

This wiring feature must NOT modify the behavior of existing SpecFlow phases (specify, plan, tasks, implement, review, rework, merge-fix). The reflect phase is additive—it runs after the cycle completes, not during it.

## Success Criteria

1. **Automatic lesson extraction:** PR merges trigger reflect work items without manual intervention
2. **Lessons queryable:** `lesson list` returns lessons after at least one reflect run completes
3. **Handler coverage:** Both scheduler and dispatch-worker can process reflect work items
4. **Type safety:** Metadata validation catches malformed reflect work items at parse time
5. **CLI availability:** All four lesson subcommands are executable via `ivy-heartbeat lesson`

## Assumptions

- The reflect orchestrator (`src/scheduler/reflect.ts`) is fully implemented and tested (F-021)
- The lesson commands (`src/commands/lesson.ts`) are fully implemented and tested (F-021)
- The blackboard schema supports `type: "reflect"` work items (no schema migration needed)
- The existing pr-merge handler has access to project_id, work_item_id, pr_number, pr_url

## Out of Scope

- Modifying the reflect orchestrator logic (already done in F-021)
- Enhancing lesson CLI commands (already done in F-021)
- Lesson deduplication logic (already implemented in reflect/analyzer.ts)
- Context injection into IMPLEMENT agents (already implemented in launcher.ts per F-021 spec)
- Quality gate for lesson extraction (already implemented in reflect orchestrator)

## Technical Notes

### Integration Points

1. **pr-merge.ts:** Add reflect work item creation after successful merge confirmation
2. **scheduler.ts:** Add `if (metadata.reflect === true)` branch in dispatch loop
3. **dispatch-worker.ts:** Add matching reflect handler for fire-and-forget mode
4. **cli.ts:** Register `lessonCommand` from `./commands/lesson`

### File Locations

- `/Users/fischer/.pai/worktrees/ivy-heartbeat/specflow-f-025/src/scheduler/pr-merge.ts` — FR-1
- `/Users/fischer/.pai/worktrees/ivy-heartbeat/specflow-f-025/src/scheduler/scheduler.ts` — FR-2
- `/Users/fischer/.pai/worktrees/ivy-heartbeat/specflow-f-025/src/commands/dispatch-worker.ts` — FR-3
- `/Users/fischer/.pai/worktrees/ivy-heartbeat/specflow-f-025/src/cli.ts` — FR-4

### Dependencies

- Reflect orchestrator: `src/scheduler/reflect.ts` (parseReflectMeta, runReflect)
- Reflect types: `src/reflect/types.ts` (ReflectMetadata)
- Lesson commands: `src/commands/lesson.ts` (lessonCommand)

### Testing Strategy

- **Unit tests:** parseReflectMeta validation (valid/invalid metadata)
- **Integration tests:** End-to-end PR merge → reflect work item → lesson extraction
- **CLI tests:** Verify lesson subcommands are registered and executable
- **Manual verification:** Complete one SpecFlow cycle, verify lessons extracted

## References

- F-021 Spec: `.specify/specs/f-021-reflect-phase-post-merge-lesson-extraction/spec.md`
- Reflect Types: `src/reflect/types.ts`
- Reflect Orchestrator: `src/scheduler/reflect.ts`
- Lesson Commands: `src/commands/lesson.ts`
