# F-021: REFLECT Phase — Post-Merge Lesson Extraction

## Problem Statement

The SpecFlow dispatch pipeline currently ends at PR merge. Each specify→implement→review→merge cycle generates valuable insights — what the spec missed, what review caught, what rework fixed — but these lessons are lost. Future IMPLEMENT agents make the same mistakes because they have no institutional memory. The REFLECT phase closes this loop by extracting structured lessons after each successful cycle and injecting them as context into future agents.

## Users & Stakeholders

- **Primary user:** PAI operator reviewing and curating lessons
- **Consumer:** Future IMPLEMENT phase agents receiving injected context
- **Technical level:** Developer comfortable with CLI, TypeScript, SQLite

## Architecture

### Phase Position in Pipeline

REFLECT is NOT a SpecFlow phase (not in `PHASE_TRANSITIONS`). It runs as a separate handler — like `review`, `rework`, and `pr-merge` — triggered after a successful PR merge. The trigger creates a `reflect` work item on the blackboard, which the dispatch worker picks up in the next cycle.

### New Files

```
src/
├── scheduler/
│   └── reflect.ts           # REFLECT phase orchestrator
├── reflect/
│   ├── analyzer.ts          # Diff analysis: spec vs implementation vs review
│   ├── lesson-schema.ts     # Zod schema for Lesson records
│   ├── lesson-injector.ts   # Selects relevant lessons for IMPLEMENT context
│   └── types.ts             # ReflectResult, LessonRecord, LessonQuery
├── commands/
│   └── lesson.ts            # CLI: lesson list / lesson search / lesson show
```

### Modified Files

- `src/scheduler/specflow-runner.ts` — No changes (reflect is not a SpecFlow phase)
- `src/scheduler/specflow-types.ts` — No changes (reflect is not a SpecFlow phase)
- `src/scheduler/pr-merge.ts` — After successful merge, create a `reflect` work item
- `src/scheduler/scheduler.ts` — Add reflect handler to dispatch pipeline (parseReflectMeta + runReflect)
- `src/commands/dispatch-worker.ts` — Add reflect handler to fire-and-forget worker
- `src/scheduler/launcher.ts` — Inject lessons context when launching IMPLEMENT agents
- `src/cli.ts` — Register `lesson` command group

## Lesson Schema

```typescript
interface LessonRecord {
  id: string;                          // Generated unique ID (e.g., "lesson-{project}-{timestamp}")
  project: string;                     // Repository/project name
  workItemId: string;                  // Source work item that produced this lesson
  phase: "implement" | "review" | "rework" | "merge-fix";  // Where the issue surfaced
  category: string;                    // e.g., "testing", "types", "architecture", "edge-cases", "dependencies"
  severity: "low" | "medium" | "high"; // Impact level
  symptom: string;                     // What went wrong (observable behavior)
  rootCause: string;                   // Why it went wrong (underlying reason)
  resolution: string;                  // How it was fixed
  constraint: string;                  // Actionable rule for future agents, imperative voice
  tags: string[];                      // Searchable tags
  createdAt: string;                   // ISO timestamp
}
```

## Blackboard Integration

### New Event Types

- `lesson.created` — payload: full LessonRecord
- `reflect.completed` — payload: `{ lessonsExtracted: number, categories: string[], workItemId: string }`

### Lessons Storage

Lessons are stored as blackboard events with `event_type: 'lesson.created'`. No separate table needed — the existing events table with FTS5 provides search, and the metadata JSON holds the full LessonRecord.

FTS5 indexing covers the `summary` field (which contains symptom + rootCause + resolution + constraint concatenated for searchability).

### Deduplication

Before persisting a new lesson, query existing lessons with FTS5 on the `constraint` field. If a match scores above a similarity threshold (e.g., >80% token overlap), skip the duplicate and log a `lesson.deduplicated` event instead.

## REFLECT Phase Implementation

### Orchestrator (`reflect.ts`)

1. **Parse metadata** from the reflect work item (project, implementation work item ID, PR number)
2. **Gather inputs** from blackboard events for the completed work item:
   - Original spec content (from specify phase artifacts)
   - Plan content (from plan phase artifacts)
   - Review results (events with `code_review.completed` targeting the work item)
   - Rework history (events from rework cycles)
   - Final diff summary (from PR merge events)
3. **Launch reflect agent** via the default launcher (`claude --print`) with a structured prompt:
   - Provide all gathered context
   - Request JSON output: array of LessonRecord objects
   - Instruct agent to analyze gaps between spec intent and implementation
   - Instruct agent to identify patterns in review feedback
   - Instruct agent to extract concrete, actionable constraints in imperative voice
4. **Parse and validate** output with Zod schema — reject malformed lessons
5. **Deduplicate** each lesson against existing lessons (FTS5 similarity)
6. **Persist** validated, unique lessons as `lesson.created` events
7. **Log** `reflect.completed` event with summary stats

### Reflect Metadata

```typescript
interface ReflectMetadata {
  reflect: true;
  project_id: string;
  implementation_work_item_id: string;
  pr_number: number;
  pr_url: string;
}
```

## Context Injection for IMPLEMENT

### Injector (`lesson-injector.ts`)

When `launcher.ts` prepares the context for an IMPLEMENT phase agent:

1. **Query lessons** from blackboard events where `event_type = 'lesson.created'`
2. **Rank by relevance:**
   - Same project lessons (high priority)
   - Same category lessons from other projects (medium priority)
   - Recent lessons across all projects (low priority)
3. **Cap at 20** most relevant lessons
4. **Format** as a `## Known Constraints` markdown section:

```markdown
## Known Constraints (from past lessons)

These constraints were learned from previous implementation cycles.
Violating them will likely cause review rejection or rework.

- [HIGH/testing] Always run type-check before committing — root cause: TypeScript strict mode catches interface mismatches that tests miss
- [MEDIUM/architecture] When modifying parser/, update corresponding test fixtures — root cause: parser tests use snapshot fixtures that go stale
```

### Integration Point

The `buildImplementationPrompt()` function in `specflow-runner.ts` (used by `runPhaseViaLauncher`) already constructs the prompt for IMPLEMENT agents. The lesson injector appends the `## Known Constraints` section to this prompt.

## CLI Commands

### `lesson list`

```
ivy-heartbeat lesson list [--project <name>] [--category <cat>] [--severity <level>] [--limit <n>]
```

Lists lessons from blackboard events. Default: last 20, sorted by recency.

### `lesson search <query>`

```
ivy-heartbeat lesson search <query>
```

FTS5 search across all lesson fields (symptom, rootCause, resolution, constraint).

### `lesson show <id>`

```
ivy-heartbeat lesson show <id>
```

Full lesson detail with all fields formatted.

### `lesson curate`

```
ivy-heartbeat lesson curate [--project <name>] [--since <date>]
```

Interactive curation: shows recent uncurated lessons one by one. User can:
- **keep** — lesson stays as-is
- **edit** — modify constraint or severity
- **discard** — remove lesson (delete event)
- **skip** — leave for later

## Quality Gate

The reflect phase should validate lesson quality:

- **Actionability:** Constraints must be imperative ("Always...", "Never...", "When X, do Y...")
- **Specificity:** Root cause must differ from symptom (not just restating)
- **Deduplication:** No near-duplicate constraints persisted
- **Minimum yield:** At least 1 lesson per reflect run (otherwise log warning, not failure)

Threshold: 80% — consistent with spec-quality and plan-quality gates.

## Test Scenarios

1. **Lesson schema validation** — valid/invalid records against Zod schema
2. **Deduplication logic** — similar constraints detected and skipped
3. **Context injection** — correct lessons selected, properly formatted, cap respected
4. **Reflect orchestrator** — input gathering, agent output parsing, persistence
5. **CLI commands** — list output formatting, search results, show detail
6. **Edge cases:**
   - No review feedback available → reflect still extracts spec→implementation gaps
   - No rework cycles → simpler analysis
   - Empty diff → no lessons extracted (log event, no failure)
   - Malformed agent output → validation rejects, logs error, marks work item failed

## Implementation Order

1. Lesson schema + types (`reflect/types.ts`, `reflect/lesson-schema.ts`)
2. Blackboard integration (event types, FTS5 querying for lessons)
3. Reflect analyzer (`reflect/analyzer.ts`) — input gathering from blackboard events
4. Reflect orchestrator (`scheduler/reflect.ts`) — agent launch, validation, dedup, persist
5. Context injector (`reflect/lesson-injector.ts`) — lesson selection, formatting
6. Launcher integration — inject lessons into IMPLEMENT prompt
7. CLI commands (`commands/lesson.ts`) — list/search/show/curate
8. Phase wiring — pr-merge creates reflect work item, scheduler/dispatch-worker handle it
9. Integration tests — full pipeline test
