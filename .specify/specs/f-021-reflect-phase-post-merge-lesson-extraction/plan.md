# Technical Plan: F-021 REFLECT Phase — Post-Merge Lesson Extraction

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         REFLECT PHASE PIPELINE                        │
└──────────────────────────────────────────────────────────────────────┘

1. PR MERGE HANDLER (pr-merge.ts)
   │
   ├─> Creates `reflect` work item on blackboard
   │   Metadata: { project_id, implementation_work_item_id, pr_number }
   │
   v

2. DISPATCH WORKER (scheduler.ts + dispatch-worker.ts)
   │
   ├─> Detects `reflect` work item
   ├─> parseReflectMeta() extracts metadata
   │
   v

3. REFLECT ORCHESTRATOR (scheduler/reflect.ts)
   │
   ├─> Gather inputs from blackboard events:
   │   • Spec content (from specify phase artifacts)
   │   • Plan content (from plan phase artifacts)
   │   • Review results (code_review.completed events)
   │   • Rework history (rework cycle events)
   │   • Final diff summary (PR merge events)
   │
   ├─> Launch reflect agent (claude --print)
   │   Prompt: Analyze spec→implementation gaps, extract lessons
   │
   ├─> Parse JSON output → LessonRecord[]
   │
   ├─> For each lesson:
   │   ├─> Validate with Zod schema
   │   ├─> Deduplicate against existing lessons (FTS5 similarity)
   │   └─> Persist as `lesson.created` event
   │
   └─> Log `reflect.completed` event with stats
       │
       v

4. BLACKBOARD STORAGE (events table with FTS5)
   │
   ├─> Events table structure:
   │   • event_type: 'lesson.created'
   │   • summary: concatenated searchable text
   │   • metadata: full LessonRecord JSON
   │
   └─> FTS5 virtual table indexes summary field
       │
       v

5. LESSON INJECTOR (reflect/lesson-injector.ts)
   │
   ├─> Query lessons from blackboard (FTS5 + relevance ranking)
   ├─> Rank by: same project > same category > recent
   ├─> Cap at 20 most relevant
   └─> Format as "## Known Constraints" markdown section
       │
       v

6. LAUNCHER INTEGRATION (scheduler/launcher.ts)
   │
   ├─> buildImplementationPrompt() constructs IMPLEMENT prompt
   └─> Append injected lessons section to prompt
       │
       v

7. IMPLEMENT AGENT (specflow-runner.ts)
   │
   └─> Receives context with past lessons
       Prompt includes: "## Known Constraints (from past lessons)"
```

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Runtime** | Bun | Project standard, fast startup, native TypeScript |
| **Database** | SQLite (existing ivy-heartbeat DB) | Local-first, already initialized, FTS5 support |
| **Schema Validation** | Zod | Project pattern for runtime validation, used across codebase |
| **CLI Framework** | Commander.js | Project standard (`src/cli.ts` existing pattern) |
| **Agent Invocation** | `claude --print` | Project standard launcher for headless AI agents |
| **Search** | SQLite FTS5 | Built-in full-text search, no external dependencies |
| **Deduplication** | Token overlap similarity | Lightweight, no embedding models needed for MVP |

## Data Model

### LessonRecord Schema

```typescript
// src/reflect/types.ts

export interface LessonRecord {
  id: string;                          // Generated: `lesson-${project}-${timestamp}`
  project: string;                     // Repository/project name (e.g., "ivy-heartbeat")
  workItemId: string;                  // Source work item ID that produced this lesson
  phase: "implement" | "review" | "rework" | "merge-fix";  // Where issue surfaced
  category: string;                    // e.g., "testing", "types", "architecture", "edge-cases"
  severity: "low" | "medium" | "high"; // Impact level
  symptom: string;                     // Observable behavior (what went wrong)
  rootCause: string;                   // Underlying reason (why it went wrong)
  resolution: string;                  // How it was fixed
  constraint: string;                  // Actionable rule (imperative: "Always...", "Never...")
  tags: string[];                      // Searchable keywords
  createdAt: string;                   // ISO timestamp
}

export interface ReflectMetadata {
  reflect: true;
  project_id: string;
  implementation_work_item_id: string;
  pr_number: number;
  pr_url: string;
}

export interface ReflectResult {
  lessonsExtracted: number;
  lessonsDeduped: number;
  lessonsPersisted: number;
  categories: string[];
  workItemId: string;
}

export interface LessonQuery {
  project?: string;
  category?: string;
  severity?: "low" | "medium" | "high";
  searchText?: string;                 // FTS5 query
  limit?: number;
}
```

### Zod Schema

```typescript
// src/reflect/lesson-schema.ts

import { z } from "zod";

export const LessonRecordSchema = z.object({
  id: z.string(),
  project: z.string().min(1),
  workItemId: z.string().min(1),
  phase: z.enum(["implement", "review", "rework", "merge-fix"]),
  category: z.string().min(1),
  severity: z.enum(["low", "medium", "high"]),
  symptom: z.string().min(10),
  rootCause: z.string().min(10),
  resolution: z.string().min(10),
  constraint: z.string().min(10),
  tags: z.array(z.string()),
  createdAt: z.string().datetime(),
});

export type LessonRecord = z.infer<typeof LessonRecordSchema>;
```

### Blackboard Storage

Lessons are stored as blackboard events, leveraging existing infrastructure:

```sql
-- No new table needed — use existing events table
INSERT INTO events (event_type, summary, metadata)
VALUES (
  'lesson.created',
  -- summary: concatenated searchable text for FTS5
  symptom || ' ' || rootCause || ' ' || resolution || ' ' || constraint,
  -- metadata: full LessonRecord JSON
  json(?)
);
```

FTS5 indexing on the `summary` field enables fast search:

```sql
-- FTS5 query example (handled by existing blackboard infrastructure)
SELECT * FROM events
WHERE event_type = 'lesson.created'
  AND summary MATCH 'testing type-check'
ORDER BY created_at DESC
LIMIT 20;
```

### New Blackboard Event Types

| Event Type | Payload | Purpose |
|------------|---------|---------|
| `lesson.created` | Full LessonRecord | Persistent lesson storage |
| `lesson.deduplicated` | `{ duplicateOf: string, constraint: string }` | Log skipped duplicates |
| `reflect.completed` | ReflectResult | Aggregate stats per reflect run |

## API Contracts

### Reflect Agent Prompt Structure

The reflect agent receives structured input and must return valid JSON:

**Input Prompt:**

```markdown
# Reflect Phase — Extract Implementation Lessons

## Context

You are analyzing a completed SpecFlow cycle to extract actionable lessons for future agents.

**Project:** {project}
**Work Item:** {workItemId}
**PR:** {prUrl}

## Inputs

### Original Specification
{specContent}

### Technical Plan
{planContent}

### Review Feedback
{reviewResults}

### Rework History
{reworkEvents}

### Final Diff Summary
{diffSummary}

## Task

Analyze the gap between:
1. What the spec described
2. What was implemented
3. What review caught
4. What rework fixed

Extract lessons that would prevent similar issues in future implementations.

## Output Format

Return a JSON array of lesson objects. Each lesson must follow this schema:

```json
[
  {
    "phase": "implement | review | rework | merge-fix",
    "category": "testing | types | architecture | edge-cases | dependencies | ...",
    "severity": "low | medium | high",
    "symptom": "Observable behavior — what went wrong",
    "rootCause": "Why it went wrong — underlying reason",
    "resolution": "How it was fixed",
    "constraint": "Actionable rule in imperative voice: 'Always...', 'Never...', 'When X, do Y...'",
    "tags": ["keyword1", "keyword2"]
  }
]
```

## Quality Requirements

- **Actionability:** Constraints must be imperative and specific
- **Specificity:** Root cause must differ from symptom (not just restating)
- **Uniqueness:** Avoid near-duplicates of existing lessons
- **Minimum yield:** Extract at least 1 lesson per analysis

Output only the JSON array. No commentary.
```

**Expected Output:**

```json
[
  {
    "phase": "implement",
    "category": "testing",
    "severity": "high",
    "symptom": "TypeScript strict mode errors not caught until CI",
    "rootCause": "Local development skipped type-check step before commit",
    "resolution": "Added pre-commit hook running tsc --noEmit",
    "constraint": "Always run type-check before committing — root cause: TypeScript strict mode catches interface mismatches that tests miss",
    "tags": ["typescript", "type-check", "ci", "pre-commit"]
  }
]
```

### CLI Command Contracts

#### `lesson list`

```bash
ivy-heartbeat lesson list [--project <name>] [--category <cat>] [--severity <level>] [--limit <n>]
```

**Output:**

```
┌─────────────────┬─────────┬──────────┬────────────┬─────────────────────────────────────┐
│ ID              │ Severity│ Category │ Phase      │ Constraint (first 60 chars)         │
├─────────────────┼─────────┼──────────┼────────────┼─────────────────────────────────────┤
│ lesson-ivy-123  │ HIGH    │ testing  │ implement  │ Always run type-check before comm...│
│ lesson-ivy-124  │ MEDIUM  │ types    │ review     │ When modifying parser/, update te...│
└─────────────────┴─────────┴──────────┴────────────┴─────────────────────────────────────┘

Total: 2 lessons
```

#### `lesson search <query>`

```bash
ivy-heartbeat lesson search "type-check testing"
```

**Output:**

```
Found 3 lessons matching "type-check testing":

[1] lesson-ivy-123 (HIGH/testing)
Constraint: Always run type-check before committing
Root Cause: TypeScript strict mode catches interface mismatches that tests miss
Tags: typescript, type-check, ci

[2] lesson-ivy-127 (MEDIUM/testing)
Constraint: When adding new parser rules, add snapshot tests
Root Cause: Parser tests use snapshot fixtures that go stale
Tags: parser, snapshot, testing
```

#### `lesson show <id>`

```bash
ivy-heartbeat lesson show lesson-ivy-123
```

**Output:**

```
Lesson: lesson-ivy-123
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Project:     ivy-heartbeat
Work Item:   work-item-456
Phase:       implement
Category:    testing
Severity:    HIGH
Created:     2026-02-24T10:30:00Z

Symptom:     TypeScript strict mode errors not caught until CI
Root Cause:  Local development skipped type-check step before commit
Resolution:  Added pre-commit hook running tsc --noEmit
Constraint:  Always run type-check before committing — root cause: TypeScript strict mode catches interface mismatches that tests miss

Tags:        typescript, type-check, ci, pre-commit
```

## Implementation Phases

### Phase 1: Foundation (Data Layer + Schema)

**Files:**
- `src/reflect/types.ts` — TypeScript interfaces
- `src/reflect/lesson-schema.ts` — Zod validation schema

**Tasks:**
1. Define `LessonRecord`, `ReflectMetadata`, `ReflectResult`, `LessonQuery` interfaces
2. Implement Zod schema with validation rules
3. Write unit tests for schema validation (valid/invalid cases)

**Dependencies:**
- None (pure types and validation)

**Completion Criteria:**
- All interfaces exported
- Zod schema validates valid lessons
- Zod schema rejects malformed lessons (missing fields, invalid enums, short strings)

---

### Phase 2: Blackboard Integration (Storage + Query)

**Files:**
- `src/reflect/analyzer.ts` — Input gathering from blackboard events

**Tasks:**
1. Implement `gatherReflectInputs(db, metadata)` function:
   - Query spec content from specify phase artifacts
   - Query plan content from plan phase artifacts
   - Query review results from `code_review.completed` events
   - Query rework history from rework cycle events
   - Query diff summary from PR merge events
2. Implement `persistLesson(db, lesson)` function:
   - Insert `lesson.created` event with searchable summary
   - Generate unique lesson ID
3. Implement `queryLessons(db, query)` function:
   - FTS5 search on summary field
   - Filter by project/category/severity
   - Sort by relevance and recency
4. Write unit tests with mock blackboard events

**Dependencies:**
- Existing blackboard infrastructure (`src/db/index.ts`, `src/events/`)

**Completion Criteria:**
- `gatherReflectInputs` returns complete context object
- `persistLesson` inserts valid events
- `queryLessons` returns ranked results from FTS5

---

### Phase 3: Deduplication Logic

**Files:**
- `src/reflect/analyzer.ts` (extend with dedup function)

**Tasks:**
1. Implement `isLessonDuplicate(db, newLesson)` function:
   - Query existing lessons with FTS5 on `constraint` field
   - Calculate token overlap similarity (simple word-set intersection)
   - Return true if similarity > 80% threshold
2. Implement `logDuplicateLesson(db, duplicateOf, constraint)` function:
   - Insert `lesson.deduplicated` event
3. Write unit tests with near-duplicate and unique lessons

**Dependencies:**
- Phase 2 (query functions)

**Completion Criteria:**
- Near-duplicate lessons detected with >80% similarity
- Unique lessons pass deduplication check
- Deduplication events logged

---

### Phase 4: Reflect Orchestrator

**Files:**
- `src/scheduler/reflect.ts` — Main orchestrator logic

**Tasks:**
1. Implement `runReflect(db, workItem)` function:
   - Parse metadata from work item
   - Gather inputs via `gatherReflectInputs`
   - Build reflect agent prompt (structured markdown)
   - Launch agent via `claude --print`
   - Parse JSON output
   - Validate each lesson with Zod
   - Deduplicate each lesson
   - Persist validated, unique lessons
   - Log `reflect.completed` event with stats
   - Return ReflectResult
2. Implement `parseReflectMeta(metadata)` function:
   - Extract project_id, implementation_work_item_id, pr_number
   - Validate required fields
3. Write integration tests with mock agent output

**Dependencies:**
- Phase 1 (schema validation)
- Phase 2 (input gathering, persistence)
- Phase 3 (deduplication)
- Existing launcher infrastructure (`src/scheduler/launcher.ts` patterns)

**Completion Criteria:**
- Valid agent output parsed and persisted
- Malformed agent output rejected with validation errors
- Deduplication applied before persistence
- Stats logged correctly

---

### Phase 5: Context Injection for IMPLEMENT

**Files:**
- `src/reflect/lesson-injector.ts` — Lesson selection and formatting
- `src/scheduler/launcher.ts` — MODIFY to append lessons context

**Tasks:**
1. Implement `selectRelevantLessons(db, project, limit)` function:
   - Query lessons ranked by relevance (same project > same category > recent)
   - Cap at specified limit (default 20)
2. Implement `formatLessonsAsMarkdown(lessons)` function:
   - Generate "## Known Constraints" section
   - Format: `[SEVERITY/category] Constraint — root cause: ...`
3. Modify `buildImplementationPrompt()` in launcher:
   - Call `selectRelevantLessons` for current project
   - Append formatted lessons section to prompt
4. Write unit tests for selection ranking and formatting

**Dependencies:**
- Phase 2 (query functions)
- Existing `buildImplementationPrompt` in launcher

**Completion Criteria:**
- Lessons ranked correctly (same project prioritized)
- Markdown formatting matches specified structure
- IMPLEMENT agents receive injected lessons in prompt

---

### Phase 6: Dispatch Pipeline Integration

**Files:**
- `src/scheduler/pr-merge.ts` — MODIFY to create reflect work item
- `src/scheduler/scheduler.ts` — MODIFY to add reflect handler
- `src/commands/dispatch-worker.ts` — MODIFY to add reflect handler

**Tasks:**
1. Modify `runPRMerge()` in pr-merge.ts:
   - After successful merge, create reflect work item on blackboard
   - Metadata: `{ reflect: true, project_id, implementation_work_item_id, pr_number, pr_url }`
2. Add `parseReflectMeta()` and `runReflect()` handlers to scheduler.ts dispatch logic
3. Add reflect handler to fire-and-forget worker in dispatch-worker.ts
4. Write integration tests simulating full pipeline (PR merge → reflect work item → reflect execution)

**Dependencies:**
- Phase 4 (orchestrator)
- Existing PR merge infrastructure

**Completion Criteria:**
- PR merge creates reflect work item
- Dispatch worker detects and executes reflect work items
- Full pipeline test passes (PR merge → reflect → lessons persisted)

---

### Phase 7: CLI Commands

**Files:**
- `src/commands/lesson.ts` — CLI command handlers
- `src/cli.ts` — MODIFY to register `lesson` command group

**Tasks:**
1. Implement `lesson list` command:
   - Parse flags: `--project`, `--category`, `--severity`, `--limit`
   - Query lessons via `queryLessons`
   - Format table output
2. Implement `lesson search <query>` command:
   - Parse search query
   - Execute FTS5 search
   - Format results with truncated preview
3. Implement `lesson show <id>` command:
   - Query lesson by ID
   - Format full detail view
4. Implement `lesson curate` command (optional for Phase 7):
   - Interactive prompt loop
   - Actions: keep, edit, discard, skip
   - Update lesson events or delete
5. Register `lesson` command group in main CLI
6. Write E2E tests for each command

**Dependencies:**
- Phase 2 (query functions)
- Existing CLI infrastructure (Commander.js patterns)

**Completion Criteria:**
- All commands executable and produce correct output
- Table formatting matches examples
- Search returns ranked results
- Show displays full lesson detail

---

### Phase 8: Testing & Validation

**Files:**
- `tests/reflect/*.test.ts` — Comprehensive test suite

**Tasks:**
1. Unit tests:
   - Schema validation (valid/invalid lessons)
   - Deduplication logic (near-duplicates, unique lessons)
   - Lesson selection ranking (project priority, category, recency)
   - Markdown formatting
2. Integration tests:
   - Input gathering from mock blackboard events
   - Agent output parsing and validation
   - Full reflect pipeline (input → agent → validation → persistence)
3. E2E tests:
   - PR merge → reflect work item creation
   - Dispatch worker executes reflect
   - Lessons injected into IMPLEMENT agent prompt
   - CLI commands with real database
4. Edge case tests:
   - No review feedback available
   - No rework cycles
   - Empty diff (no lessons extracted)
   - Malformed agent output

**Dependencies:**
- All prior phases

**Completion Criteria:**
- Test coverage >80%
- All edge cases handled gracefully
- E2E test simulates full pipeline successfully

## File Structure

```
src/
├── reflect/
│   ├── types.ts              # TypeScript interfaces (LessonRecord, ReflectMetadata, etc.)
│   ├── lesson-schema.ts      # Zod validation schema
│   ├── analyzer.ts           # Input gathering, deduplication, persistence
│   └── lesson-injector.ts    # Lesson selection and markdown formatting
├── scheduler/
│   ├── reflect.ts            # REFLECT orchestrator (runReflect, parseReflectMeta)
│   ├── pr-merge.ts           # MODIFY: create reflect work item after merge
│   ├── scheduler.ts          # MODIFY: add reflect handler to dispatch
│   └── launcher.ts           # MODIFY: inject lessons into IMPLEMENT prompt
├── commands/
│   ├── lesson.ts             # CLI: lesson list / search / show / curate
│   └── dispatch-worker.ts    # MODIFY: add reflect handler
├── cli.ts                    # MODIFY: register lesson command group
└── tests/
    └── reflect/
        ├── schema.test.ts           # Zod validation tests
        ├── analyzer.test.ts         # Input gathering, dedup, persistence tests
        ├── injector.test.ts         # Lesson selection and formatting tests
        ├── orchestrator.test.ts     # Reflect orchestrator integration tests
        ├── pipeline.test.ts         # Full pipeline E2E tests
        └── cli.test.ts              # CLI command tests
```

## Dependencies

### Internal Dependencies

| Component | Depends On | Why |
|-----------|-----------|-----|
| `reflect/analyzer.ts` | Blackboard infrastructure (`src/db/`, `src/events/`) | Query events, persist lessons |
| `scheduler/reflect.ts` | `reflect/analyzer.ts`, `reflect/lesson-schema.ts`, launcher patterns | Orchestration logic |
| `reflect/lesson-injector.ts` | `reflect/analyzer.ts` (query functions) | Lesson selection |
| `scheduler/launcher.ts` | `reflect/lesson-injector.ts` | Context injection |
| `commands/lesson.ts` | `reflect/analyzer.ts` (query functions) | CLI data access |

### External Dependencies

| Package | Purpose | Already Installed? |
|---------|---------|-------------------|
| `zod` | Runtime validation | ✅ Yes (project standard) |
| `commander` | CLI framework | ✅ Yes (used in `src/cli.ts`) |
| `bun:sqlite` | SQLite driver | ✅ Yes (project standard) |

**No new external dependencies required.**

### Blackboard Event Prerequisites

The reflect phase requires these event types to already exist:

- Specify phase artifacts (spec content)
- Plan phase artifacts (plan content)
- `code_review.completed` events (review results)
- Rework cycle events (rework history)
- PR merge events (diff summary)

**Integration Point:** All prerequisites already exist in the current system.

### Launcher Modification

The `buildImplementationPrompt()` function in `src/scheduler/launcher.ts` (or equivalent IMPLEMENT prompt builder) must be modified to:

1. Accept project context (project ID)
2. Call `selectRelevantLessons(db, project, 20)`
3. Call `formatLessonsAsMarkdown(lessons)`
4. Append formatted section to prompt

**Current Implementation:** Check `specflow-runner.ts` for exact function name and signature.

## Risk Assessment

### Risk 1: Reflect Agent Output Quality

**Impact:** High
**Probability:** Medium

**Description:** The reflect agent may produce low-quality lessons (vague constraints, restated symptoms, unhelpful root causes).

**Mitigation Strategies:**

1. **Strong prompt engineering:**
   - Provide concrete examples of good vs. bad lessons in the prompt
   - Require imperative voice for constraints ("Always...", "Never...")
   - Require root cause to differ from symptom
2. **Validation layer:**
   - Zod schema enforces minimum string lengths (10+ chars)
   - Post-validation filter: reject lessons where `rootCause === symptom` (string similarity check)
3. **Human curation:**
   - Implement `lesson curate` command for manual review
   - Track curation stats (% discarded) to tune agent prompts
4. **Iterative prompt refinement:**
   - Log reflect agent outputs to blackboard
   - Analyze patterns in rejected lessons
   - Refine prompt based on failure modes

**Fallback:** If agent quality is persistently poor, add a "review required" flag to lessons and gate IMPLEMENT injection on manual approval.

---

### Risk 2: Deduplication False Negatives

**Impact:** Medium
**Probability:** Medium

**Description:** Token overlap similarity may miss semantically duplicate lessons phrased differently.

**Mitigation Strategies:**

1. **Start with simple heuristics:**
   - 80% token overlap threshold catches most exact duplicates
   - Add constraint normalization (lowercase, punctuation stripping)
2. **Log deduplication decisions:**
   - Track `lesson.deduplicated` events
   - Manual review of near-misses (70-79% similarity)
3. **Future enhancement path:**
   - If false negatives become common, upgrade to embedding-based similarity
   - Use `nomic-embed-text` (lightweight) or `text-embedding-3-small`
   - Cosine similarity threshold: 0.9
4. **Accept some redundancy:**
   - Better to have 2 similar lessons than miss an important one
   - Cap total lessons injected at 20 to limit prompt bloat

**Fallback:** Periodic manual deduplication via `lesson curate` command.

---

### Risk 3: Context Injection Prompt Bloat

**Impact:** Medium
**Probability:** Low

**Description:** Injecting 20 lessons into IMPLEMENT prompts may exceed token limits or dilute focus.

**Mitigation Strategies:**

1. **Relevance ranking:**
   - Prioritize same-project lessons (high signal)
   - Deprioritize old lessons (>90 days) unless high severity
2. **Truncation:**
   - Cap at 20 lessons hard limit
   - If >20 relevant lessons, rank by severity then recency
3. **Formatting efficiency:**
   - Use compact format: `[SEVERITY/category] Constraint — root cause: ...`
   - Omit resolution and tags from injected context (full detail in CLI only)
4. **Monitor impact:**
   - Track IMPLEMENT agent performance (rework rate) before vs. after injection
   - If performance degrades, reduce cap to 10-15 lessons

**Fallback:** Add `--no-lessons` flag to IMPLEMENT launcher for debugging.

---

### Risk 4: Blackboard Event Schema Evolution

**Impact:** Low
**Probability:** Low

**Description:** If blackboard event schema changes (e.g., metadata JSON structure), lesson queries may break.

**Mitigation Strategies:**

1. **Defensive querying:**
   - Always validate JSON structure with try-catch
   - Gracefully handle missing fields (log warning, skip lesson)
2. **Schema version tracking:**
   - Include `schemaVersion: 1` in LessonRecord
   - Allow future schema migrations
3. **Test coverage:**
   - Integration tests with mock events
   - E2E tests with real blackboard

**Fallback:** If schema breaks in production, lessons can be manually exported and re-imported with migration script.

---

### Risk 5: Reflect Agent Hangs or Fails

**Impact:** High
**Probability:** Low

**Description:** The reflect agent may hang, timeout, or produce malformed JSON.

**Mitigation Strategies:**

1. **Timeout enforcement:**
   - Set 120-second timeout on `claude --print` invocation
   - If timeout exceeded, log `reflect.failed` event and mark work item failed
2. **JSON parsing resilience:**
   - Wrap JSON.parse in try-catch
   - If parsing fails, log raw output and mark work item failed
3. **Retry logic:**
   - Allow 1 retry on timeout or parse failure
   - If second attempt fails, mark work item failed and alert operator
4. **Graceful degradation:**
   - Reflect failure does NOT block PR merge (merge already completed)
   - Missing lessons are a quality issue, not a pipeline blocker

**Fallback:** Manual lesson extraction from PR diff if reflect consistently fails.

---

### Risk 6: CLI Performance with Large Lesson Sets

**Impact:** Low
**Probability:** Low

**Description:** If thousands of lessons accumulate, CLI commands may become slow.

**Mitigation Strategies:**

1. **Pagination:**
   - Default `--limit 20` for all list/search commands
   - Allow override with `--limit N`
2. **Indexes:**
   - FTS5 virtual table provides fast search
   - Add index on `created_at` for recency sorting
3. **Archival strategy:**
   - After 6 months, move lessons to archive table
   - Keep only high-severity lessons in active set

**Fallback:** Add `--archived` flag to search archived lessons if needed.

---

## Quality Gates

### Reflect Agent Output Quality

**Threshold:** 80% of lessons pass validation on first attempt.

**Validation Rules:**

1. **Actionability:** Constraint must start with imperative verb ("Always", "Never", "When X, do Y")
2. **Specificity:** Root cause must differ from symptom (token overlap <50%)
3. **Minimum length:** All text fields ≥10 characters
4. **Deduplication:** No >80% similarity to existing lessons

**Measurement:**

- Log `reflect.agent_output_validation` event with pass/fail ratio
- Track rolling average over 10 reflect runs
- If <80% pass rate, alert operator to review agent prompt

### Lesson Injection Effectiveness

**Threshold:** Rework rate decreases by ≥20% for features with injected lessons.

**Measurement:**

- Track rework events per work item (before vs. after lesson injection enabled)
- Compare rework rate for same-category features across 30-day windows
- If no improvement after 10 work items, review lesson quality and relevance ranking

### CLI Usability

**Threshold:** All commands complete in <2 seconds for datasets ≤1000 lessons.

**Measurement:**

- Benchmark `lesson list`, `lesson search`, `lesson show` with 1000-lesson fixture
- If >2 seconds, add indexes or optimize queries

---

## Open Questions

1. **Lesson lifecycle:** Should lessons expire after N days? Or stay forever?
   - **Recommendation:** Keep all lessons, add `--recent` flag to filter by date
2. **Multi-project sharing:** Should lessons from one project inform another?
   - **Recommendation:** Yes, but rank same-project lessons higher (current design)
3. **Human review workflow:** Should lessons be auto-approved or require manual review?
   - **Recommendation:** Auto-approve for MVP, add `lesson curate` for manual review in Phase 7
4. **Reflect agent model:** Should we use a specific Claude model (e.g., Sonnet 4.5)?
   - **Recommendation:** Use project default (`claude --print` inherits from launcher)

---

## Future Enhancements (Post-MVP)

1. **Embedding-based similarity:** Replace token overlap with vector embeddings for better deduplication
2. **Lesson scoring:** Track which lessons actually prevent rework (count references in IMPLEMENT logs)
3. **Category taxonomy:** Standardize category names (currently free-form strings)
4. **Cross-project analytics:** Dashboard showing lesson trends across all projects
5. **Lesson templates:** Pre-populate common lessons (e.g., "Always run type-check") as starter set
6. **Agent feedback loop:** IMPLEMENT agents report which lessons were helpful (thumbs up/down)

---

## Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Lesson extraction rate | ≥1 lesson per reflect run | Avg `lessonsExtracted` in `reflect.completed` events |
| Deduplication rate | 10-20% lessons deduplicated | Ratio of `lesson.deduplicated` to total lessons processed |
| IMPLEMENT rework rate | ≥20% decrease | Compare rework events before/after injection enabled |
| CLI response time | <2 seconds for 1000 lessons | Benchmark test suite |
| Agent output quality | ≥80% pass validation | Validation pass rate in `reflect.agent_output_validation` events |

---

## Implementation Checklist

- [ ] Phase 1: Foundation (types, schema, tests)
- [ ] Phase 2: Blackboard integration (storage, query)
- [ ] Phase 3: Deduplication logic
- [ ] Phase 4: Reflect orchestrator
- [ ] Phase 5: Context injection for IMPLEMENT
- [ ] Phase 6: Dispatch pipeline integration
- [ ] Phase 7: CLI commands
- [ ] Phase 8: Testing & validation
- [ ] Documentation: Update README with lesson workflow
- [ ] Deployment: Test on staging before production
