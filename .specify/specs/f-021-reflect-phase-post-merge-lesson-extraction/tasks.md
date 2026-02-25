# Implementation Tasks: F-021 REFLECT Phase — Post-Merge Lesson Extraction

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | ☐ | |
| T-1.2 | ☐ | |
| T-2.1 | ☐ | |
| T-2.2 | ☐ | |
| T-2.3 | ☐ | |
| T-3.1 | ☐ | |
| T-3.2 | ☐ | |
| T-4.1 | ☐ | |
| T-4.2 | ☐ | |
| T-5.1 | ☐ | |
| T-5.2 | ☐ | |
| T-5.3 | ☐ | |
| T-6.1 | ☐ | |
| T-6.2 | ☐ | |
| T-6.3 | ☐ | |
| T-7.1 | ☐ | |
| T-7.2 | ☐ | |
| T-7.3 | ☐ | |
| T-7.4 | ☐ | |
| T-7.5 | ☐ | |
| T-8.1 | ☐ | |
| T-8.2 | ☐ | |
| T-8.3 | ☐ | |
| T-8.4 | ☐ | |

## Group 1: Foundation (Data Layer + Schema)

### T-1.1: Define TypeScript interfaces and types [T]
- **File:** src/reflect/types.ts
- **Test:** tests/reflect/schema.test.ts
- **Dependencies:** none
- **Description:** Create LessonRecord, ReflectMetadata, ReflectResult, LessonQuery interfaces with complete type definitions

### T-1.2: Implement Zod validation schema [T]
- **File:** src/reflect/lesson-schema.ts
- **Test:** tests/reflect/schema.test.ts
- **Dependencies:** T-1.1
- **Description:** Create LessonRecordSchema with validation rules (min lengths, enum constraints, datetime format)

## Group 2: Blackboard Integration (Storage + Query)

### T-2.1: Implement input gathering from blackboard events [T]
- **File:** src/reflect/analyzer.ts
- **Test:** tests/reflect/analyzer.test.ts
- **Dependencies:** T-1.1
- **Description:** Create gatherReflectInputs() function to query spec, plan, review, rework, and diff events

### T-2.2: Implement lesson persistence to blackboard [T]
- **File:** src/reflect/analyzer.ts
- **Test:** tests/reflect/analyzer.test.ts
- **Dependencies:** T-1.1, T-1.2
- **Description:** Create persistLesson() function to insert lesson.created events with searchable summary

### T-2.3: Implement lesson query with FTS5 search [T] [P with T-3.1]
- **File:** src/reflect/analyzer.ts
- **Test:** tests/reflect/analyzer.test.ts
- **Dependencies:** T-2.2
- **Description:** Create queryLessons() function with FTS5 search, filtering by project/category/severity, ranked results

## Group 3: Deduplication Logic

### T-3.1: Implement duplicate detection with token overlap [T] [P with T-2.3]
- **File:** src/reflect/analyzer.ts
- **Test:** tests/reflect/analyzer.test.ts
- **Dependencies:** T-2.2
- **Description:** Create isLessonDuplicate() function using FTS5 constraint search with 80% similarity threshold

### T-3.2: Implement deduplication event logging [T]
- **File:** src/reflect/analyzer.ts
- **Test:** tests/reflect/analyzer.test.ts
- **Dependencies:** T-3.1
- **Description:** Create logDuplicateLesson() function to insert lesson.deduplicated events

## Group 4: Reflect Orchestrator

### T-4.1: Implement reflect orchestration logic [T]
- **File:** src/scheduler/reflect.ts
- **Test:** tests/reflect/orchestrator.test.ts
- **Dependencies:** T-2.1, T-2.2, T-3.1, T-3.2
- **Description:** Create runReflect() function: gather inputs, launch agent, parse JSON, validate, deduplicate, persist, log stats

### T-4.2: Implement reflect metadata parsing [T]
- **File:** src/scheduler/reflect.ts
- **Test:** tests/reflect/orchestrator.test.ts
- **Dependencies:** T-1.1
- **Description:** Create parseReflectMeta() function to extract project_id, implementation_work_item_id, pr_number with validation

## Group 5: Context Injection for IMPLEMENT

### T-5.1: Implement lesson selection with relevance ranking [T]
- **File:** src/reflect/lesson-injector.ts
- **Test:** tests/reflect/injector.test.ts
- **Dependencies:** T-2.3
- **Description:** Create selectRelevantLessons() function ranking by same project > same category > recent, capped at 20

### T-5.2: Implement markdown formatting for lesson context [T]
- **File:** src/reflect/lesson-injector.ts
- **Test:** tests/reflect/injector.test.ts
- **Dependencies:** T-5.1
- **Description:** Create formatLessonsAsMarkdown() generating "## Known Constraints" section with [SEVERITY/category] format

### T-5.3: Modify launcher to inject lessons into IMPLEMENT prompt [T]
- **File:** src/scheduler/launcher.ts
- **Test:** tests/reflect/injector.test.ts
- **Dependencies:** T-5.1, T-5.2
- **Description:** Modify buildImplementationPrompt() to call selectRelevantLessons, format, and append to prompt

## Group 6: Dispatch Pipeline Integration

### T-6.1: Modify PR merge to create reflect work item [T]
- **File:** src/scheduler/pr-merge.ts
- **Test:** tests/reflect/pipeline.test.ts
- **Dependencies:** T-1.1
- **Description:** Modify runPRMerge() to create reflect work item with metadata after successful merge

### T-6.2: Add reflect handler to scheduler dispatch logic [T]
- **File:** src/scheduler/scheduler.ts
- **Test:** tests/reflect/pipeline.test.ts
- **Dependencies:** T-4.1, T-4.2
- **Description:** Add parseReflectMeta() and runReflect() handlers to scheduler dispatch pipeline

### T-6.3: Add reflect handler to fire-and-forget worker [T]
- **File:** src/commands/dispatch-worker.ts
- **Test:** tests/reflect/pipeline.test.ts
- **Dependencies:** T-4.1, T-4.2
- **Description:** Add reflect handler to dispatch-worker for background execution

## Group 7: CLI Commands

### T-7.1: Implement lesson list command [T]
- **File:** src/commands/lesson.ts
- **Test:** tests/reflect/cli.test.ts
- **Dependencies:** T-2.3
- **Description:** Create list command with --project, --category, --severity, --limit flags, table output formatting

### T-7.2: Implement lesson search command [T]
- **File:** src/commands/lesson.ts
- **Test:** tests/reflect/cli.test.ts
- **Dependencies:** T-2.3
- **Description:** Create search command with FTS5 query execution, formatted results with preview

### T-7.3: Implement lesson show command [T]
- **File:** src/commands/lesson.ts
- **Test:** tests/reflect/cli.test.ts
- **Dependencies:** T-2.3
- **Description:** Create show command querying lesson by ID with full detail formatting

### T-7.4: Implement lesson curate command [T]
- **File:** src/commands/lesson.ts
- **Test:** tests/reflect/cli.test.ts
- **Dependencies:** T-2.3, T-2.2
- **Description:** Create curate command with interactive prompt loop for keep/edit/discard/skip actions

### T-7.5: Register lesson command group in main CLI [T]
- **File:** src/cli.ts
- **Test:** tests/reflect/cli.test.ts
- **Dependencies:** T-7.1, T-7.2, T-7.3, T-7.4
- **Description:** Register lesson command group with Commander.js in main CLI entrypoint

## Group 8: Testing & Validation

### T-8.1: Write unit tests for schema and analyzer [T]
- **File:** tests/reflect/schema.test.ts, tests/reflect/analyzer.test.ts
- **Test:** (self-testing)
- **Dependencies:** T-1.2, T-2.1, T-2.2, T-2.3, T-3.1, T-3.2
- **Description:** Comprehensive unit tests for validation, deduplication, input gathering, persistence, queries

### T-8.2: Write integration tests for orchestrator [T]
- **File:** tests/reflect/orchestrator.test.ts
- **Test:** (self-testing)
- **Dependencies:** T-4.1, T-4.2
- **Description:** Integration tests for agent output parsing, validation, full reflect pipeline with mock events

### T-8.3: Write E2E tests for full pipeline [T]
- **File:** tests/reflect/pipeline.test.ts
- **Test:** (self-testing)
- **Dependencies:** T-6.1, T-6.2, T-6.3, T-5.3
- **Description:** E2E tests for PR merge → reflect work item → execution → lesson injection into IMPLEMENT

### T-8.4: Write edge case tests [T]
- **File:** tests/reflect/analyzer.test.ts, tests/reflect/orchestrator.test.ts
- **Test:** (self-testing)
- **Dependencies:** T-8.1, T-8.2
- **Description:** Edge cases: no review feedback, no rework, empty diff, malformed agent output

## Execution Order

1. **Phase 1 (Foundation):** T-1.1, T-1.2 (sequential)
2. **Phase 2 (Blackboard - parallel batch 1):** T-2.1, T-2.2 → T-2.3 and T-3.1 in parallel
3. **Phase 3 (Deduplication):** T-3.2 (after T-3.1)
4. **Phase 4 (Orchestrator):** T-4.1, T-4.2 (sequential, after Groups 2+3)
5. **Phase 5 (Injection - parallel batch 2):** T-5.1 → T-5.2 and T-5.3 (T-5.2 parallel with T-5.3)
6. **Phase 6 (Pipeline):** T-6.1, T-6.2, T-6.3 (sequential, after Group 4)
7. **Phase 7 (CLI - parallel batch 3):** T-7.1, T-7.2, T-7.3, T-7.4 in parallel → T-7.5
8. **Phase 8 (Testing):** T-8.1, T-8.2, T-8.3, T-8.4 (as each implementation completes)

**Parallel opportunities:**
- Batch 1: T-2.3 || T-3.1 (both depend on T-2.2)
- Batch 2: T-5.2 || T-5.3 (after T-5.1)
- Batch 3: T-7.1 || T-7.2 || T-7.3 || T-7.4 (all independent)
