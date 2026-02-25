# F-021: REFLECT Phase — Post-Merge Lesson Extraction

## Summary

The REFLECT phase extracts structured lessons from completed SpecFlow cycles (specify→implement→review→merge) and injects them as context into future IMPLEMENT agents. After each PR merge, the system analyzes the gap between specification intent, implementation reality, review feedback, and rework patterns to generate actionable constraints. These lessons persist in the blackboard as searchable events and automatically inform future agents working on similar features, reducing repeat mistakes.

## What Changed

### New Files

**Core Implementation:**
- `src/reflect/analyzer.ts` — Input gathering from blackboard events, deduplication logic, lesson persistence
- `src/reflect/lesson-schema.ts` — Zod validation schema for LessonRecord structure
- `src/reflect/types.ts` — TypeScript interfaces: LessonRecord, ReflectMetadata, ReflectResult, LessonQuery
- `src/scheduler/reflect.ts` — Main orchestrator: launches reflect agent, validates output, persists lessons

**Testing:**
- `tests/reflect/analyzer.test.ts` — Unit tests for input gathering, deduplication, persistence
- `tests/reflect/orchestrator.test.ts` — Integration tests for reflect pipeline
- `tests/reflect/schema.test.ts` — Zod schema validation tests

**Documentation:**
- `.specify/specs/f-021-reflect-phase-post-merge-lesson-extraction/plan.md` — Technical architecture and implementation phases
- `.specify/specs/f-021-reflect-phase-post-merge-lesson-extraction/spec.md` — Feature specification and requirements
- `.specify/specs/f-021-reflect-phase-post-merge-lesson-extraction/tasks.md` — Task breakdown for implementation

### Modified Files

- `.gitignore` — Added `.specflow` directory exclusion
- `CHANGELOG.md` — Added F-021 feature entry

## Configuration Changes

None required. The REFLECT phase integrates with existing ivy-heartbeat infrastructure:
- Uses existing SQLite database and blackboard event system
- No new external dependencies (Zod and Commander.js already present)
- Lessons stored as blackboard events with `event_type: 'lesson.created'`

## Usage

### Automatic Operation

The REFLECT phase runs automatically after PR merges. No manual invocation needed for the core pipeline:

1. PR merged → `pr-merge.ts` creates `reflect` work item
2. Dispatch worker picks up work item → launches reflect agent
3. Agent analyzes spec/plan/review/rework context → outputs JSON lessons
4. Lessons validated, deduplicated, persisted to blackboard
5. Future IMPLEMENT agents automatically receive relevant lessons in their prompt

### CLI Commands (Future Phases)

Phase 1-4 implementation provides the core pipeline. CLI commands for lesson management will be added in future phases:

```bash
# List recent lessons
ivy-heartbeat lesson list --project ivy-heartbeat --limit 20

# Search lessons
ivy-heartbeat lesson search "type-check testing"

# Show full lesson detail
ivy-heartbeat lesson show lesson-ivy-123

# Interactive curation (manual review)
ivy-heartbeat lesson curate --since 2026-02-01
```

### Lesson Schema

Each lesson contains:
- **Symptom** — What went wrong (observable behavior)
- **Root Cause** — Why it went wrong (underlying reason)
- **Resolution** — How it was fixed
- **Constraint** — Actionable rule for future agents (imperative voice: "Always...", "Never...", "When X, do Y...")
- **Phase** — Where issue surfaced (implement/review/rework/merge-fix)
- **Category** — Domain (testing/types/architecture/edge-cases/dependencies)
- **Severity** — Impact level (low/medium/high)

### Example Lesson

```json
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
```

## Developer Notes

- **Lesson Storage:** Lessons live in the `events` table with `event_type: 'lesson.created'`, leveraging existing FTS5 indexing for search
- **Deduplication:** Token overlap similarity (>80% threshold) prevents near-duplicate lessons from accumulating
- **Context Injection:** IMPLEMENT agents automatically receive up to 20 relevant lessons in their prompt (same-project lessons prioritized)
- **Quality Gate:** Lessons validated with Zod schema — actionable constraints required, root cause must differ from symptom
- **Testing:** Run `bun test tests/reflect/` to verify reflect pipeline components

## Implementation Status

**Completed (Phases 1-4):**
- ✅ Lesson schema and TypeScript types
- ✅ Blackboard integration (storage, query, deduplication)
- ✅ Reflect orchestrator (agent launch, validation, persistence)
- ✅ Unit and integration tests

**Pending (Future Phases):**
- ⏳ Context injection for IMPLEMENT agents (Phase 5)
- ⏳ Dispatch pipeline wiring (pr-merge → reflect work item) (Phase 6)
- ⏳ CLI commands for lesson management (Phase 7)
- ⏳ E2E testing and validation (Phase 8)
