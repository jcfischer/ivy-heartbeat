# F-019: Implementation Plan

## Approach

Add a SpecFlow dispatch code path to the existing dispatch worker. The dispatch worker already handles GitHub issues (worktree → claude → commit/push/PR). The SpecFlow path reuses the same worktree infrastructure but shells out to `specflow` CLI instead of Claude directly, and chains work items across phases.

Three new modules: a SpecFlow runner (orchestrates phases via CLI), a CLI command (manual queueing), and an evaluator (worktree cleanup). The dispatch worker gains a second code path that delegates to the runner. The web dashboard adds a pipeline view via a new API endpoint + frontend panel.

## Architecture

```
src/scheduler/specflow-runner.ts — Run one SpecFlow phase, check quality gate, chain next item
src/scheduler/specflow-types.ts  — SpecFlowPhase, SpecFlowWorkItemMetadata, phase transitions
src/commands/specflow-queue.ts   — CLI: ivy-heartbeat specflow-queue --project --feature
src/evaluators/specflow-cleanup.ts — Periodic worktree staleness cleanup evaluator
src/serve/api/specflow-pipeline.ts — API endpoint: GET /api/specflow/pipelines
src/serve/views/specflow-panel.ts  — Dashboard HTML panel for pipeline view
```

## Key Decisions

1. **SpecFlow runner is a separate module, not inline in dispatch-worker** — The dispatch worker (`dispatch-worker.ts`) detects `source === 'specflow'` in work item metadata and delegates to `specflow-runner.ts`. This keeps the dispatch worker's GitHub path untouched and avoids a 600-line file. (FR-2)

2. **Shell out to specflow CLI, not library calls** — Each phase runs `specflow <phase> <feature-id>` as a subprocess via `Bun.spawn`. Quality gates run `specflow eval run --file <artifact> --rubric <rubric> --json`. This avoids coupling to specflow internals and works with the compiled binary at `~/bin/specflow`. (FR-2, FR-4)

3. **Persistent worktrees use a different naming convention** — GitHub worktrees: `~/.pai/worktrees/{projectId}/fix/issue-{N}`. SpecFlow worktrees: `~/.pai/worktrees/{projectId}/specflow-{featureId}`. The existing `createWorktree()` in `worktree.ts` needs a small extension to support reusing an existing worktree path instead of always deleting and recreating. (FR-5)

4. **Work item chaining via `bb.createWorkItem()` at phase end** — After a successful phase, the runner calls `bb.createWorkItem()` with the next phase in metadata. The new item enters the shared priority queue. The runner does NOT call the dispatcher — the next heartbeat cycle picks it up naturally. (FR-3, FR-8)

5. **Quality gate failure creates a retry work item with feedback** — On gate failure, the runner reads the eval JSON output, extracts the feedback, and creates a retry work item for the same phase with `retry_count` incremented and `eval_feedback` populated. The specflow CLI subprocess prompt prepends this feedback. Max 1 retry (configurable). (FR-4)

6. **Git ops only after implement phase** — Only the implement phase triggers commit/push/PR, reusing the existing `commitAll()`, `pushBranch()`, `createPR()` from `worktree.ts`. The PR title format: `feat(specflow): F-{N} {title}`. PR body links to spec.md and plan.md in the branch. (FR-2 implement step)

7. **Worktree cleanup is an evaluator, not a cron job** — A new `specflow_cleanup` check type runs during periodic heartbeat checks. It scans `~/.pai/worktrees/*/specflow-*`, finds directories with no work item activity in `staleness_ttl` days, and removes them. Registered in `evaluators.ts` alongside existing evaluators. (FR-11)

8. **Project allowlist via metadata JSON** — `specflow_enabled` is stored in the project's `metadata` JSON field in the blackboard. The `specflow-queue` command checks this before creating work items. No schema changes needed. (FR-7)

9. **Specify phase uses `--batch` mode** — The runner calls `specflow specify <feature-id> --batch` so no interactive interview is needed. The feature's description (from `specflow status --json` or the DB) provides the decomposition data. (FR-9)

10. **Pipeline view is a new API + dashboard panel** — A SQL query groups SpecFlow work items by `specflow_feature_id` from metadata, showing per-feature phase progression. Added as a panel in the existing web dashboard alongside the work item table. (FR-10)

## Files to Create

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/scheduler/specflow-types.ts` | Phase type, metadata interface, phase transitions map | ~40 |
| `src/scheduler/specflow-runner.ts` | `runSpecFlowPhase()`: spawn specflow CLI, check gate, chain next item | ~200 |
| `src/commands/specflow-queue.ts` | CLI command to manually queue a SpecFlow feature for dispatch | ~60 |
| `src/evaluators/specflow-cleanup.ts` | Evaluator for periodic stale worktree cleanup | ~80 |
| `src/serve/api/specflow-pipeline.ts` | API endpoint returning pipeline status per feature | ~60 |
| `src/serve/views/specflow-panel.ts` | HTML template for pipeline visualization panel | ~80 |
| `test/specflow-runner.test.ts` | Tests for phase execution, chaining, quality gates, retries | ~200 |
| `test/specflow-queue.test.ts` | Tests for CLI command validation | ~60 |
| `test/specflow-cleanup.test.ts` | Tests for staleness detection and cleanup | ~80 |

## Files to Modify

| File | Change |
|------|--------|
| `src/commands/dispatch-worker.ts` | Add SpecFlow detection: if metadata has `specflow_phase`, delegate to `runSpecFlowPhase()` instead of launcher. Skip worktree cleanup (persistent). |
| `src/scheduler/worktree.ts` | Add `ensureWorktree()` — reuses existing worktree if path exists and is valid, otherwise creates new. Used by specflow runner for phase 2+. |
| `src/check/evaluators.ts` | Register `specflow_cleanup` evaluator in the evaluator registry. |
| `src/parser/types.ts` | Add `'specflow_cleanup'` to `CheckTypeSchema` enum. |
| `src/cli.ts` | Import and register `specflow-queue` command. |
| `src/serve/server.ts` | Add `/api/specflow/pipelines` route. Mount specflow panel in dashboard. |
| `src/scheduler/scheduler.ts` | In sync dispatch path: detect specflow source, delegate to runner (mirrors dispatch-worker change). |

## Dependencies

- F-001 (Blackboard library) — complete
- F-007 (Heartbeat check command) — complete (evaluator pattern)
- Git worktree isolation (de543c7) — complete (worktree.ts module)
- Fire-and-forget dispatch (de543c7) — complete (dispatch-worker.ts)
- SpecFlow CLI at `~/bin/specflow` — external dependency

## Test Strategy

- **specflow-runner.test.ts**: Mock `Bun.spawn` to simulate specflow CLI responses. Test each phase transition (specify→plan→tasks→implement→complete). Test quality gate pass/fail/retry. Test work item chaining creates correct metadata. Test git ops only fire after implement. Test worktree persistence (not cleaned between phases). Test retry with eval feedback in metadata.
- **specflow-queue.test.ts**: Test validation (project must exist, must have specflow_enabled, feature must exist in specflow status). Test work item creation with correct source and metadata.
- **specflow-cleanup.test.ts**: Test staleness detection (mock filesystem). Test cleanup removes worktrees older than TTL. Test active worktrees (with recent work items) are preserved. Test cleanup logs events.
- **Integration**: Mock launcher to test dispatch-worker's specflow detection path end-to-end.

## FR Coverage

| FR | Addressed By |
|----|-------------|
| FR-1: Work item source type | `specflow-types.ts` (metadata interface), work items created with `source: 'specflow'` |
| FR-2: Dispatch worker code path | `dispatch-worker.ts` (detection), `specflow-runner.ts` (execution) |
| FR-3: Work item chaining | `specflow-runner.ts` — `chainNextPhase()` calls `bb.createWorkItem()` |
| FR-4: Quality gate integration | `specflow-runner.ts` — `checkQualityGate()` runs `specflow eval` |
| FR-5: Persistent worktrees | `worktree.ts` (`ensureWorktree()`), dispatch-worker skips cleanup for specflow |
| FR-6: Manual CLI trigger | `specflow-queue.ts` CLI command |
| FR-7: Project allowlist | `specflow-queue.ts` and `specflow-runner.ts` check `specflow_enabled` in project metadata |
| FR-8: Shared priority queue | Work items use existing `priority` field, no separate queue |
| FR-9: Specify batch mode | `specflow-runner.ts` passes `--batch` flag for specify phase |
| FR-10: Observability | `specflow-pipeline.ts` (API), `specflow-panel.ts` (dashboard), events logged per phase |
| FR-11: Worktree cleanup evaluator | `specflow-cleanup.ts` evaluator registered in `evaluators.ts` |
