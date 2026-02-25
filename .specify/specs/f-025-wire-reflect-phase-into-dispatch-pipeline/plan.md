# Technical Plan: Wire REFLECT Phase into Dispatch Pipeline

## Architecture Overview

The REFLECT phase integration requires wiring four integration points into the existing dispatch pipeline:

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Dispatch Pipeline (scheduler.ts)                   │
│                                                                        │
│  ┌────────────┐   ┌──────────────┐   ┌───────────────┐              │
│  │  SpecFlow  │──>│  Merge Fix   │──>│   Rework      │              │
│  │  Handler   │   │  Handler     │   │   Handler     │              │
│  └────────────┘   └──────────────┘   └───────────────┘              │
│                                                                        │
│  ┌────────────┐   ┌──────────────┐   ┌───────────────┐   NEW        │
│  │   Review   │──>│  PR Merge    │──>│   REFLECT     │ <────────┐   │
│  │  Handler   │   │  Handler     │   │   Handler     │          │   │
│  └────────────┘   └──────────────┘   └───────────────┘          │   │
│                           │                   ▲                   │   │
│                           │                   │                   │   │
│                           └───────────────────┘                   │   │
│                        Creates reflect work item                  │   │
│                                                                    │   │
└────────────────────────────────────────────────────────────────────┼──┘
                                                                     │
┌────────────────────────────────────────────────────────────────────┼──┐
│              Fire-and-Forget Worker (dispatch-worker.ts)           │  │
│                                                                     │  │
│  ┌─────────────────────────────────────────────────────────────┐  │  │
│  │  Metadata Parser → Handler Router → runReflect()            │  │  │
│  └─────────────────────────────────────────────────────────────┘  │  │
│                                      ▲                              │  │
│                                      └──────────────────────────────┘  │
│                              Mirrors scheduler handler pattern        │
└───────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────┐
│                      CLI Registration (cli.ts)                        │
│                                                                        │
│  ┌───────────────────────────────────────────────────────────────┐   │
│  │  program.addCommand(lessonCommand)                            │   │
│  │    ├─ lesson list                                             │   │
│  │    ├─ lesson search <query>                                   │   │
│  │    ├─ lesson show <id>                                        │   │
│  │    └─ lesson curate                                           │   │
│  └───────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────┘

Data Flow:
1. PR merges successfully in pr-merge.ts → createWorkItem(type: "reflect")
2. Scheduler picks up reflect work item → parseReflectMeta() → runReflect()
3. runReflect() extracts lessons → persists as lesson.created events
4. User queries via CLI: lesson list → blackboard events → formatted output
```

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Project standard, already used in all scheduler code |
| Database | SQLite (via ivy-blackboard) | Local-first blackboard pattern, events table stores lessons |
| CLI Framework | Commander.js | Project standard, used for all CLI commands |
| Type System | TypeScript | Project standard, ReflectMetadata provides type safety |
| Testing | Bun test | Project standard, matches existing test infrastructure |

**No new dependencies required** — all necessary infrastructure exists from F-021.

## Data Model

### ReflectMetadata (work item metadata)

```typescript
// Location: src/reflect/types.ts (already exists)
interface ReflectMetadata {
  reflect: true;              // Flag for handler detection
  project_id: string;         // Project identifier
  implementation_work_item_id: string;  // Source work item
  pr_number: number;          // GitHub PR number
  pr_url: string;             // GitHub PR URL
}
```

### Work Item Structure (blackboard)

```typescript
// Created in pr-merge.ts after successful merge
{
  id: `reflect-${project_id}-pr-${pr_number}`,
  title: `Reflect on PR #${pr_number} - ${original_title}`,
  description: "Extract lessons from completed implementation cycle",
  project: project_id,
  priority: 'P2',  // Lower than implementation (P1) but higher than cleanup (P3)
  source: 'reflect',
  sourceRef: pr_url,
  metadata: JSON.stringify(ReflectMetadata),
  status: 'pending'  // Ready for scheduler pickup
}
```

### Lesson Records (persisted as events)

```typescript
// Location: src/reflect/types.ts (already exists)
interface LessonRecord {
  id: string;                 // lesson-{project}-{timestamp}
  project: string;
  workItemId: string;
  phase: "implement" | "review" | "rework" | "merge-fix";
  category: string;
  severity: "low" | "medium" | "high";
  symptom: string;
  rootCause: string;
  resolution: string;
  constraint: string;         // Actionable rule for future cycles
  tags: string[];
  createdAt: string;          // ISO 8601
}
```

Lessons are persisted as `lesson.created` events in the blackboard events table:
```sql
INSERT INTO events (actor_id, target_id, event_type, summary, metadata)
VALUES (session_id, work_item_id, 'lesson.created', category, JSON(LessonRecord));
```

## Implementation Phases

### Phase 1: PR Merge Integration (30 min)
**Goal:** Create reflect work items after successful PR merges

**Files Modified:**
- `src/scheduler/pr-merge.ts`

**Changes:**
1. Import ReflectMetadata type from `../reflect/types.ts`
2. Add `createReflectWorkItem()` function following `createMergeFixWorkItem()` pattern:
   ```typescript
   export function createReflectWorkItem(
     bb: Blackboard,
     opts: {
       projectId: string;
       implementationWorkItemId: string;
       prNumber: number;
       prUrl: string;
       originalTitle: string;
     }
   ): string {
     const itemId = `reflect-${opts.projectId}-pr-${opts.prNumber}`;
     const title = `Reflect on PR #${opts.prNumber} - ${opts.originalTitle}`;

     const description = [
       `Extract lessons from completed implementation cycle.`,
       '',
       `- **PR URL:** ${opts.prUrl}`,
       `- **Implementation Work Item:** ${opts.implementationWorkItemId}`,
       `- **Project:** ${opts.projectId}`,
     ].join('\n');

     const metadata: ReflectMetadata = {
       reflect: true,
       project_id: opts.projectId,
       implementation_work_item_id: opts.implementationWorkItemId,
       pr_number: opts.prNumber,
       pr_url: opts.prUrl,
     };

     bb.createWorkItem({
       id: itemId,
       title,
       description,
       project: opts.projectId,
       priority: 'P2',
       source: 'reflect',
       sourceRef: opts.prUrl,
       metadata: JSON.stringify(metadata),
     });

     return itemId;
   }
   ```

3. In `runPRMerge()`, after successful merge (before final status update), call:
   ```typescript
   createReflectWorkItem(bb, {
     projectId: meta.project_id,
     implementationWorkItemId: meta.implementation_work_item_id,
     prNumber: meta.pr_number,
     prUrl: meta.pr_url,
     originalTitle: item.title.replace(/^Merge approved PR #\d+ - /, ''),
   });

   bb.appendEvent({
     actorId: sessionId,
     targetId: item.item_id,
     summary: `Created reflect work item for lesson extraction`,
     metadata: { prNumber: meta.pr_number },
   });
   ```

**Testing:**
- Unit test: `createReflectWorkItem()` creates work item with correct metadata structure
- Integration test: Complete PR merge → verify reflect work item appears on blackboard

### Phase 2: Scheduler Handler (30 min)
**Goal:** Enable scheduler to recognize and dispatch reflect work items

**Files Modified:**
- `src/scheduler/scheduler.ts`

**Changes:**
1. Add imports at top:
   ```typescript
   import { parseReflectMeta, runReflect } from './reflect.ts';
   ```

2. Add handler in synchronous dispatch loop (after PR merge handler, before generic GitHub item handling):
   ```typescript
   // Determine if this is a reflect work item (line ~586, after PR merge handler)
   const reflectMeta = parseReflectMeta(item.metadata);
   if (reflectMeta && project) {
     try {
       await runReflect(bb, reflectMeta, launcher);
       bb.completeWorkItem(item.item_id, sessionId);
       const durationMs = Date.now() - startTime;

       bb.appendEvent({
         actorId: sessionId,
         targetId: item.item_id,
         summary: `Reflect phase completed for PR #${reflectMeta.pr_number} (${Math.round(durationMs / 1000)}s)`,
         metadata: { prNumber: reflectMeta.pr_number, durationMs },
       });

       result.dispatched.push({
         itemId: item.item_id,
         title: item.title,
         projectId: item.project_id!,
         sessionId,
         exitCode: 0,
         completed: true,
         durationMs,
       });
     } catch (err: unknown) {
       const msg = err instanceof Error ? err.message : String(err);
       const durationMs = Date.now() - startTime;
       try { bb.releaseWorkItem(item.item_id, sessionId); } catch { /* best effort */ }

       bb.appendEvent({
         actorId: sessionId,
         targetId: item.item_id,
         summary: `Reflect phase failed for PR #${reflectMeta.pr_number}: ${msg}`,
         metadata: { error: msg, durationMs },
       });

       result.errors.push({
         itemId: item.item_id,
         title: item.title,
         error: `Reflect failed: ${msg}`,
       });
     } finally {
       bb.deregisterAgent(sessionId);
     }
     continue;
   }
   ```

**Pattern Consistency:** Matches existing handlers (merge-fix, rework, pr-merge):
- Parse metadata with dedicated function
- Try-catch block with duration tracking
- Complete work item on success, release on failure
- Append events for observability
- Deregister agent in finally block
- Continue to skip generic handler

**Testing:**
- Unit test: `parseReflectMeta()` validates metadata structure
- Integration test: Reflect work item on blackboard → scheduler processes it → lessons persisted

### Phase 3: Dispatch Worker Handler (20 min)
**Goal:** Enable fire-and-forget worker to handle reflect work items

**Files Modified:**
- `src/commands/dispatch-worker.ts`

**Changes:**
1. Add imports:
   ```typescript
   import { parseReflectMeta, runReflect } from '../scheduler/reflect.ts';
   ```

2. Add handler in worker's dispatch logic (mirror scheduler structure):
   ```typescript
   // After rework handler, before code review handler
   const reflectMeta = parseReflectMeta(item.metadata);
   if (reflectMeta) {
     // Resolve project for local_path
     const project = reflectMeta.project_id ? bb.getProject(reflectMeta.project_id) : null;
     if (!project) {
       throw new Error(`Project ${reflectMeta.project_id} not found for reflect work item`);
     }

     // Heartbeat before work
     sendHeartbeat(bb, sessionId, item.item_id, 'Extracting lessons from completed cycle');

     // Import getLauncher from scheduler (already available in file)
     const launcher = getLauncher();
     await runReflect(bb, reflectMeta, launcher);

     // Heartbeat after work
     sendHeartbeat(bb, sessionId, item.item_id, `Reflect completed for PR #${reflectMeta.pr_number}`);
     return;
   }
   ```

**Pattern Consistency:** Matches existing worker handlers (review, rework):
- Parse metadata
- Resolve project
- Send heartbeat before work
- Invoke handler
- Send heartbeat after work
- Early return

**Testing:**
- Integration test: Fire-and-forget worker processes reflect work item successfully
- Verify heartbeat events appear in blackboard

### Phase 4: CLI Registration (10 min)
**Goal:** Make lesson commands accessible via CLI

**Files Modified:**
- `src/cli.ts`

**Changes:**
1. Add import:
   ```typescript
   import { lessonCommand } from './commands/lesson.ts';
   ```

2. Register command (after existing command registrations):
   ```typescript
   // Lesson management (after work command, before exiting)
   program.addCommand(lessonCommand);
   ```

**Testing:**
- CLI test: `ivy-heartbeat lesson --help` shows subcommands
- CLI test: Each subcommand (list, search, show, curate) is executable
- Integration test: After reflect run completes, `lesson list` returns extracted lessons

## File Structure

```
src/
├── scheduler/
│   ├── reflect.ts              # [Existing] Orchestrator (parseReflectMeta, runReflect)
│   ├── pr-merge.ts             # [MODIFIED] Add createReflectWorkItem()
│   └── scheduler.ts            # [MODIFIED] Add reflect handler
├── commands/
│   ├── dispatch-worker.ts      # [MODIFIED] Add reflect handler
│   ├── lesson.ts               # [Existing] CLI commands (list, search, show, curate)
│   └── ...
├── cli.ts                      # [MODIFIED] Register lessonCommand
└── reflect/
    ├── types.ts                # [Existing] ReflectMetadata, LessonRecord
    ├── analyzer.ts             # [Existing] Lesson extraction logic
    └── deduplicator.ts         # [Existing] Duplicate detection
```

**No new files required** — all infrastructure exists from F-021.

## Dependencies

### Internal Dependencies
- `src/scheduler/reflect.ts` — Reflect orchestrator (parseReflectMeta, runReflect)
- `src/reflect/types.ts` — ReflectMetadata, LessonRecord types
- `src/commands/lesson.ts` — CLI command definitions
- `ivy-blackboard` — Blackboard API (createWorkItem, appendEvent)

### External Dependencies
None — no new packages required.

### Prerequisites
- F-021 implementation complete (reflect orchestrator, lesson commands)
- Blackboard schema supports reflect work items (no migration needed)
- `launcher()` function available for spawning Claude agents

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| **Premature reflect execution** | High — lessons extracted before cycle completes, context incomplete | Low | FR-7 enforces work item creation only in pr-merge.ts after successful merge. Grep validation catches violations. |
| **Handler pattern divergence** | Medium — inconsistent error handling, maintainability issues | Medium | NFR-1 requires exact pattern matching with existing handlers. Code review validates structure. |
| **Metadata validation gaps** | Medium — malformed metadata causes runtime errors | Low | `parseReflectMeta()` validates all fields, throws on missing/incorrect data. TypeScript provides compile-time safety. |
| **CLI commands not registered** | Low — feature exists but inaccessible to users | Medium | FR-4 explicitly requires registration. Manual test (`lesson --help`) validates availability. |
| **Duplicate work item creation** | Low — same PR creates multiple reflect items | Low | Work item ID includes project + PR number, ensuring uniqueness. Blackboard enforces ID uniqueness. |
| **Fire-and-forget worker failure** | High — reflect work items never processed in background mode | Medium | Phase 3 adds handler to dispatch-worker.ts. Integration test validates fire-and-forget path. |
| **Lesson CLI empty results** | Medium — users can't verify lesson extraction worked | Medium | FR-6 end-to-end test validates full pipeline. Manual verification after first reflect run. |

**Critical Path:** Phase 1 → Phase 2 → Phase 4 (minimum viable). Phase 3 can be deferred if fire-and-forget mode is not required.

## Testing Strategy

### Unit Tests
- **Phase 1:** `createReflectWorkItem()` constructs correct metadata
- **Phase 2:** `parseReflectMeta()` validates required fields, rejects invalid metadata
- **Phase 3:** Worker handler calls `runReflect()` with correct arguments
- **Phase 4:** CLI registration makes subcommands available

### Integration Tests
1. **End-to-end pipeline:**
   - Create implementation work item → complete review → merge PR
   - Verify reflect work item created with correct metadata
   - Verify scheduler processes reflect work item
   - Verify lessons persisted as `lesson.created` events
   - Verify `lesson list` returns extracted lessons

2. **Fire-and-forget path:**
   - Create reflect work item manually
   - Dispatch with `fireAndForget: true`
   - Verify worker processes work item
   - Verify heartbeat events appear
   - Verify lessons persisted

3. **CLI availability:**
   - Run `ivy-heartbeat lesson --help` → verify subcommands listed
   - Run `lesson list` → verify output format
   - Run `lesson search <query>` → verify FTS5 search works
   - Run `lesson show <id>` → verify full lesson detail
   - Run `lesson curate` → verify interactive mode (skip in CI)

### Manual Verification
After implementation, complete one full SpecFlow cycle:
1. Create feature spec (specify phase)
2. Implement feature (implement phase)
3. Review PR (review phase)
4. Merge PR (pr-merge phase)
5. Wait ~5 minutes for scheduler to pick up reflect work item
6. Run `ivy-heartbeat lesson list` → verify lessons extracted
7. Run `ivy-heartbeat lesson show <id>` → verify lesson content

## Implementation Order

**Critical path (must be sequential):**
1. Phase 1 (PR merge integration) — creates reflect work items
2. Phase 2 (Scheduler handler) — processes reflect work items
3. Phase 4 (CLI registration) — exposes lesson commands

**Optional parallel work:**
- Phase 3 (Dispatch worker) — can be implemented alongside Phase 2 (no dependency)

**Estimated Total Time:** ~90 minutes (30 + 30 + 20 + 10)

## Verification Checklist

After implementation, verify:
- [ ] `grep -r 'type: "reflect"' src/` shows only `pr-merge.ts` (FR-7)
- [ ] TypeScript compilation passes with no errors (FR-8)
- [ ] `ivy-heartbeat lesson --help` shows four subcommands (FR-4, FR-5)
- [ ] Reflect work item appears after PR merge (FR-1)
- [ ] Scheduler processes reflect work item without errors (FR-2)
- [ ] Dispatch worker handles reflect work items (FR-3)
- [ ] `lesson list` returns lessons after reflect run (FR-6)
- [ ] No changes to existing phase handlers (NFR-2)
- [ ] Handler patterns match existing structure (NFR-1)

## Success Metrics

1. **Automatic pipeline:** PR merge → reflect work item creation (no manual intervention)
2. **Lesson persistence:** At least one lesson extracted and persisted per reflect run
3. **CLI availability:** All four lesson subcommands executable
4. **Handler consistency:** Reflect handler structure matches existing handlers
5. **Zero regressions:** No behavioral changes to existing SpecFlow phases

[PHASE COMPLETE: PLAN]
