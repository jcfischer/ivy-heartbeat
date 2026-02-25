# F-025: Wire REFLECT Phase into Dispatch Pipeline - Documentation

## Summary

F-025 integrates the REFLECT phase (implemented in F-021) into the SpecFlow dispatch pipeline. The REFLECT phase was previously built but architecturally isolated—when PRs merged successfully, no reflect work items were created, and the scheduler/dispatch-worker had no handlers to process them. This integration wires four critical integration points to close the institutional memory loop:

1. **PR merge creates reflect work items** — After successful PR merge, `pr-merge.ts` creates a reflect work item on the blackboard
2. **Scheduler processes reflect work items** — `scheduler.ts` recognizes and dispatches reflect work items to the reflect orchestrator
3. **Fire-and-forget worker handles reflect** — `dispatch-worker.ts` mirrors the scheduler's reflect handler for async mode
4. **Lesson CLI commands available** — `cli.ts` registers the lesson command group, making lesson management accessible

**Result:** PR merges now automatically trigger lesson extraction. Agents learn from past cycles through injected lesson context in future IMPLEMENT phases.

## What Changed

### Files Modified

| File | Lines Changed | Purpose |
|------|--------------|---------|
| `src/scheduler/pr-merge.ts` | +80 | Added `createReflectWorkItem()` function and integration |
| `src/scheduler/scheduler.ts` | +52 | Added reflect handler in dispatch loop |
| `src/commands/dispatch-worker.ts` | +50 | Added reflect handler for fire-and-forget mode |
| `CHANGELOG.md` | +1 | Documented F-025 completion |

### Files Added

| File | Lines | Purpose |
|------|-------|---------|
| `.specify/specs/f-025-wire-reflect-phase-into-dispatch-pipeline/spec.md` | 243 | Feature specification |
| `.specify/specs/f-025-wire-reflect-phase-into-dispatch-pipeline/plan.md` | 474 | Technical implementation plan |
| `.specify/specs/f-025-wire-reflect-phase-into-dispatch-pipeline/tasks.md` | 130 | Task breakdown |

### Key Changes

**1. PR Merge Integration (`src/scheduler/pr-merge.ts`)**

Added `createReflectWorkItem()` function that creates reflect work items after successful PR merges. Triggered after PR merge confirmation in `runPRMerge()`, before final status update.

**Metadata Structure:**
```typescript
{
  reflect: true,
  project_id: string,
  implementation_work_item_id: string,
  pr_number: number,
  pr_url: string
}
```

**2. Scheduler Handler (`src/scheduler/scheduler.ts`)**

Added reflect work item handler in the main dispatch loop:

- Imports `parseReflectMeta` and `runReflect` from `./reflect.ts`
- Conditional branch: `if (reflectMeta && project)`
- Follows existing handler pattern (try-catch, duration tracking, events, cleanup)
- Location: After PR merge handler, before generic GitHub item handling

**3. Dispatch Worker Handler (`src/commands/dispatch-worker.ts`)**

Mirrors the scheduler's reflect handler for fire-and-forget mode with heartbeat events and project resolution.

**4. Test Updates**

- `test/specflow-runner.test.ts` — Updated spawner call count assertion (+1 for reflect phase)

## Configuration & Setup

### Prerequisites

- **F-021 must be complete** — The reflect orchestrator (`src/scheduler/reflect.ts`) and lesson commands (`src/commands/lesson.ts`) must exist
- **Blackboard schema** — No migration needed; supports custom work item types
- **Environment** — Bun runtime (project standard)

### No New Dependencies

All infrastructure exists from F-021. No package installations required.

### Lesson CLI Commands

After F-025, these commands are available:

```bash
# List recent lessons
ivy-heartbeat lesson list [--project <name>] [--category <cat>] [--severity <level>] [--limit <n>]

# Full-text search
ivy-heartbeat lesson search <query>

# Show full detail
ivy-heartbeat lesson show <id>

# Interactive curation
ivy-heartbeat lesson curate [--project <name>] [--since <date>]
```

## Usage

### Automatic Workflow

The reflect phase runs automatically after PR merges:

1. Implementation cycle completes (feature implemented, reviewed, PR merged)
2. Reflect work item created by `pr-merge.ts` with ReflectMetadata
3. Scheduler picks up work item (~5 minutes)
4. Lessons extracted and persisted as `lesson.created` events
5. Future IMPLEMENT phases receive relevant lessons as context

### Manual Verification

After a PR merge:

```bash
# Wait ~5 minutes for scheduler

# Check for lessons
ivy-heartbeat lesson list

# Show detail
ivy-heartbeat lesson show <id>

# Search
ivy-heartbeat lesson search "authentication"
```

## Architecture

### Data Flow

```
PR Merge → createReflectWorkItem() → Blackboard work item
    ↓
Scheduler/Worker → parseReflectMeta() → runReflect()
    ↓
Reflect Orchestrator → Extract lessons → Persist events
    ↓
Lesson CLI → Query/display
```

### Work Item Lifecycle

```
PR merge success
    → reflect work item (status: pending)
    → scheduler claims item (status: in-progress)
    → runReflect() extracts lessons
    → work item completed (status: completed)
    → lessons queryable via CLI
```

## Technical Details

### Reflect Metadata

```typescript
interface ReflectMetadata {
  reflect: true;              // Handler detection flag
  project_id: string;
  implementation_work_item_id: string;
  pr_number: number;
  pr_url: string;
}
```

### Lesson Record

```typescript
interface LessonRecord {
  id: string;
  project: string;
  workItemId: string;
  phase: "implement" | "review" | "rework" | "merge-fix";
  category: string;
  severity: "low" | "medium" | "high";
  symptom: string;
  rootCause: string;
  resolution: string;
  constraint: string;         // Actionable rule
  tags: string[];
  createdAt: string;
}
```

### Handler Pattern

The reflect handlers follow existing handler patterns:
- Metadata parsing (`parseReflectMeta`)
- Handler invocation (`runReflect`)
- Conditional branching
- Error handling with duration tracking
- Event logging
- Agent cleanup

## Testing

### Coverage

- Unit tests for `parseReflectMeta()` validation
- Integration tests for end-to-end pipeline
- Spawner assertion updates (+1 for reflect phase)

### Manual Test

1. Complete SpecFlow cycle (specify → implement → review → merge)
2. Wait ~5 minutes
3. Run `ivy-heartbeat lesson list`
4. Run `ivy-heartbeat lesson show <id>`

## Limitations

- Lesson deduplication uses built-in heuristics (not configurable)
- Interactive curation requires TTY (not CI-friendly)
- Reflect timing depends on scheduler interval (~5 minutes)
- No on-demand CLI trigger for reflect (requires work item)

## References

- F-021 Spec: `.specify/specs/f-021-reflect-phase-post-merge-lesson-extraction/spec.md`
- Reflect Orchestrator: `src/scheduler/reflect.ts`
- Reflect Types: `src/reflect/types.ts`
- Lesson Commands: `src/commands/lesson.ts`
