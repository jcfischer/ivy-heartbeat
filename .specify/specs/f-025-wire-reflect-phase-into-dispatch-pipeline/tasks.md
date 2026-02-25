# Implementation Tasks: Wire reflect phase into dispatch pipeline

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | ☐ | |
| T-1.2 | ☐ | |
| T-1.3 | ☐ | |
| T-1.4 | ☐ | |
| T-2.1 | ☐ | |
| T-2.2 | ☐ | |
| T-2.3 | ☐ | |
| T-2.4 | ☐ | |
| T-3.1 | ☐ | |
| T-3.2 | ☐ | |
| T-4.1 | ☐ | |
| T-4.2 | ☐ | |
| T-4.3 | ☐ | |

## Group 1: PR Merge Integration

### T-1.1: Add createReflectWorkItem function [T]
- **File:** src/scheduler/pr-merge.ts
- **Test:** tests/scheduler/pr-merge.test.ts (new test case)
- **Dependencies:** none
- **Description:** Implement `createReflectWorkItem()` function following `createMergeFixWorkItem()` pattern. Constructs ReflectMetadata with project_id, implementation_work_item_id, pr_number, pr_url. Creates work item with type "reflect", priority P2, source "reflect".

### T-1.2: Wire reflect work item creation after PR merge [T]
- **File:** src/scheduler/pr-merge.ts
- **Test:** tests/scheduler/pr-merge.test.ts (integration test)
- **Dependencies:** T-1.1
- **Description:** In `runPRMerge()`, after successful PR merge confirmation (before final status update), invoke `createReflectWorkItem()` with extracted metadata. Append event to blackboard logging reflect work item creation. Extract original title by removing "Merge approved PR #N - " prefix.

### T-1.3: Add unit tests for createReflectWorkItem [T]
- **File:** tests/scheduler/pr-merge.test.ts
- **Test:** Same file (test implementation)
- **Dependencies:** T-1.1
- **Description:** Unit tests validating: (1) work item ID format `reflect-{project}-pr-{number}`, (2) title format, (3) description includes PR URL and work item ID, (4) metadata structure matches ReflectMetadata type, (5) priority is P2, (6) source is "reflect".

### T-1.4: Add integration test for PR merge to reflect flow [T]
- **File:** tests/integration/pr-merge-reflect.test.ts (new file)
- **Test:** Same file (test implementation)
- **Dependencies:** T-1.2
- **Description:** End-to-end test: Create implementation work item → complete review → trigger PR merge → verify reflect work item appears on blackboard with correct metadata. Validates FR-1 and FR-6 integration point.

## Group 2: Scheduler Dispatch Handler

### T-2.1: Import reflect orchestrator in scheduler [T]
- **File:** src/scheduler/scheduler.ts
- **Test:** TypeScript compilation (static verification)
- **Dependencies:** T-1.2 (requires reflect work items to exist for testing)
- **Description:** Add import statement: `import { parseReflectMeta, runReflect } from './reflect.ts';` at top of scheduler.ts. Verify TypeScript compilation passes with no errors (validates FR-8 type safety).

### T-2.2: Add reflect handler to dispatch loop [T] [P with T-3.1]
- **File:** src/scheduler/scheduler.ts
- **Test:** tests/scheduler/scheduler.test.ts (new test case)
- **Dependencies:** T-2.1
- **Description:** Add reflect handler in synchronous dispatch loop after PR merge handler (line ~586). Pattern: parse metadata with `parseReflectMeta()`, invoke `runReflect(bb, reflectMeta, launcher)` in try-catch, complete work item on success, append duration event, release on failure, deregister agent in finally block. Validates FR-2 handler pattern consistency (NFR-1).

### T-2.3: Add unit tests for parseReflectMeta validation [T]
- **File:** tests/scheduler/reflect.test.ts (extends existing F-021 tests)
- **Test:** Same file (test implementation)
- **Dependencies:** T-2.1
- **Description:** Unit tests for `parseReflectMeta()`: (1) valid metadata with all required fields passes, (2) missing reflect flag throws, (3) missing project_id throws, (4) missing pr_number throws, (5) invalid pr_number type throws. Validates FR-8 metadata type safety.

### T-2.4: Add integration test for scheduler reflect processing [T]
- **File:** tests/integration/scheduler-reflect.test.ts (new file)
- **Test:** Same file (test implementation)
- **Dependencies:** T-2.2
- **Description:** Integration test: Create reflect work item on blackboard → trigger scheduler dispatch → verify `runReflect()` invoked → verify lessons persisted as `lesson.created` events → verify work item marked complete. Validates FR-2 and FR-6 end-to-end.

## Group 3: Dispatch Worker Handler

### T-3.1: Add reflect handler to dispatch worker [T] [P with T-2.2]
- **File:** src/commands/dispatch-worker.ts
- **Test:** tests/commands/dispatch-worker.test.ts (new test case)
- **Dependencies:** T-2.1 (same reflect orchestrator imports)
- **Description:** Add reflect handler in worker dispatch logic matching scheduler structure. Parse metadata with `parseReflectMeta()`, resolve project for local_path, send heartbeat before work, invoke `runReflect()`, send heartbeat after completion, early return. Validates FR-3 handler pattern consistency (NFR-1).

### T-3.2: Add integration test for fire-and-forget reflect [T]
- **File:** tests/integration/dispatch-worker-reflect.test.ts (new file)
- **Test:** Same file (test implementation)
- **Dependencies:** T-3.1
- **Description:** Integration test: Create reflect work item → dispatch with `fireAndForget: true` → verify worker processes work item → verify heartbeat events appear → verify lessons persisted. Validates FR-3 fire-and-forget path.

## Group 4: CLI Registration and End-to-End Verification

### T-4.1: Register lessonCommand in CLI [T]
- **File:** src/cli.ts
- **Test:** tests/cli/lesson-registration.test.ts (new file)
- **Dependencies:** T-2.2, T-3.1 (handlers operational)
- **Description:** Import `lessonCommand` from `./commands/lesson.ts`. Register with Commander.js: `program.addCommand(lessonCommand);` after existing command registrations (work, agent, project). Validates FR-4 CLI registration requirement.

### T-4.2: Verify lesson subcommands available [T]
- **File:** tests/cli/lesson-commands.test.ts (new file)
- **Test:** Same file (test implementation)
- **Dependencies:** T-4.1
- **Description:** CLI tests validating: (1) `ivy-heartbeat lesson --help` shows four subcommands, (2) `lesson list` executable with correct output format, (3) `lesson search <query>` performs FTS5 search, (4) `lesson show <id>` displays full lesson detail. Validates FR-5 subcommand availability.

### T-4.3: End-to-end pipeline verification [T]
- **File:** tests/integration/full-pipeline-reflect.test.ts (new file)
- **Test:** Same file (test implementation)
- **Dependencies:** T-1.4, T-2.4, T-3.2, T-4.2 (all integration points)
- **Description:** Full pipeline test simulating complete SpecFlow cycle: specify → implement → review → merge → verify reflect work item created → verify scheduler processes → verify lessons extracted → verify `lesson list` returns lessons. Validates FR-6 end-to-end trigger verification and success criteria #1 (automatic lesson extraction).

## Execution Order

**Phase 1 (Sequential — Foundation):**
1. T-1.1 (create function — no dependencies)
2. T-1.2 (wire function — depends on T-1.1)
3. T-1.3 (unit tests — depends on T-1.1, can run parallel with T-1.2)
4. T-1.4 (integration test — depends on T-1.2)

**Phase 2 (Parallel Opportunity):**
- T-2.1, T-2.2, T-2.3, T-2.4 (scheduler path)
- T-3.1, T-3.2 (worker path — can run in parallel with scheduler after T-2.1 imports available)

**Phase 3 (Sequential — CLI):**
1. T-4.1 (register commands — depends on T-2.2/T-3.1)
2. T-4.2 (verify subcommands — depends on T-4.1)
3. T-4.3 (end-to-end — depends on all prior tasks)

**Critical Path:** T-1.1 → T-1.2 → T-2.1 → T-2.2 → T-4.1 → T-4.2 → T-4.3

**Parallelizable:** T-2.2 (scheduler handler) and T-3.1 (dispatch worker handler) can be implemented simultaneously — they operate on identical metadata structures but invoke handlers in different execution contexts (synchronous dispatch loop vs fire-and-forget worker).

**Total Tasks:** 13 (4 foundation + 4 scheduler + 2 worker + 3 CLI/integration)
**Test Tasks:** 10 (marked with [T])
**Parallel Tasks:** 2 (T-2.2 and T-3.1 marked with [P])
