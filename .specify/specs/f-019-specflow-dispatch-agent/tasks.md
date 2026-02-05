# F-019: SpecFlow Dispatch Agent — Tasks

## T-1: Create SpecFlow types (src/scheduler/specflow-types.ts)
- [ ] Define `SpecFlowPhase` type: `'specify' | 'plan' | 'tasks' | 'implement' | 'complete'`
- [ ] Define `SpecFlowWorkItemMetadata` interface (feature_id, phase, project_id, worktree_path, main_branch, retry_count, eval_feedback)
- [ ] Define `PHASE_TRANSITIONS` map: specify→plan, plan→tasks, tasks→implement, implement→complete
- [ ] Define `PHASE_RUBRICS` map: specify→spec-quality, plan→plan-quality
- [ ] Define `PHASE_ARTIFACTS` map: specify→spec.md, plan→plan.md
- [ ] Helper: `parseSpecFlowMeta(metadata: string | null)` — parse and validate JSON metadata
- [ ] Helper: `nextPhase(current: SpecFlowPhase)` — return next phase or null if complete

## T-2: Add ensureWorktree to worktree module (src/scheduler/worktree.ts)
- [ ] `ensureWorktree(projectPath, worktreePath, branch)` — if worktree exists and is valid, return it; otherwise create it
- [ ] Validate existing worktree: check directory exists AND `git worktree list` includes it
- [ ] If invalid/orphaned: prune, then create fresh
- [ ] Export alongside existing `createWorktree` and `removeWorktree`

## T-3: Build SpecFlow runner (src/scheduler/specflow-runner.ts)
- [ ] `runSpecFlowPhase(bb, item, project, sessionId)` — main entry point
- [ ] Determine worktree path: first phase creates via `createWorktree()`, subsequent phases use `ensureWorktree()` from metadata
- [ ] Build specflow CLI command based on phase (specify gets `--batch`, implement gets `--feature`)
- [ ] Spawn `specflow <phase> <feature-id>` via `Bun.spawn()` in worktree dir
- [ ] Handle timeout via existing pattern (setTimeout + SIGTERM)
- [ ] On exit 0: check quality gate if applicable (specify, plan)
- [ ] `checkQualityGate(worktreePath, phase, featureId)` — run `specflow eval run --file --rubric --json`, parse score
- [ ] On gate pass: call `chainNextPhase()`
- [ ] On gate fail: call `chainRetry()` if retry_count < max, else mark failed
- [ ] `chainNextPhase(bb, item, nextPhase, worktreePath, mainBranch)` — create new work item with next phase metadata
- [ ] `chainRetry(bb, item, evalFeedback)` — create retry work item with incremented retry_count and eval_feedback
- [ ] Implement phase special handling: on exit 0, run commitAll → pushBranch → createPR (reuse worktree.ts)
- [ ] PR title format: `feat(specflow): F-{N} {title}`
- [ ] PR body: link to spec.md and plan.md on the branch
- [ ] Complete phase: run `specflow complete <feature-id>`, clean up worktree on success
- [ ] Log blackboard events at each stage (phase start, gate result, chain, git ops, completion)

## T-4: Modify dispatch worker for SpecFlow detection (src/commands/dispatch-worker.ts)
- [ ] After resolving work item and project, check metadata for `specflow_phase`
- [ ] If specflow: call `runSpecFlowPhase()` instead of building prompt + calling launcher
- [ ] Skip worktree cleanup for specflow items (persistent worktrees)
- [ ] Ensure deregisterAgent still happens in finally block
- [ ] Keep existing GitHub code path completely unchanged

## T-5: Modify sync dispatch path (src/scheduler/scheduler.ts)
- [ ] Mirror the dispatch-worker detection: if metadata has `specflow_phase`, delegate to `runSpecFlowPhase()`
- [ ] Skip worktree cleanup for specflow items in finally block
- [ ] Keep existing GitHub and non-GitHub code paths unchanged

## T-6: Create CLI command (src/commands/specflow-queue.ts)
- [ ] `ivy-heartbeat specflow-queue --project <id> --feature <id> [--priority <n>]`
- [ ] Validate project exists on blackboard
- [ ] Validate project has `specflow_enabled: true` in metadata JSON
- [ ] Validate specflow CLI is available (`which specflow`)
- [ ] Check feature exists: run `specflow status --json` and verify feature ID
- [ ] Check no existing specflow work item for this feature (prevent duplicates)
- [ ] Create work item: `source: 'specflow'`, title from feature name, metadata with phase='specify'
- [ ] Register command in `src/cli.ts`

## T-7: Add specflow_cleanup check type (src/parser/types.ts, src/check/evaluators.ts)
- [ ] Add `'specflow_cleanup'` to `CheckTypeSchema` enum in `src/parser/types.ts`
- [ ] Register `evaluateSpecFlowCleanup` in evaluator registry in `src/check/evaluators.ts`

## T-8: Create cleanup evaluator (src/evaluators/specflow-cleanup.ts)
- [ ] `evaluateSpecFlowCleanup(item: ChecklistItem)` — scan and prune stale worktrees
- [ ] Parse config: `staleness_days` (default 7)
- [ ] Scan `~/.pai/worktrees/*/specflow-*` directories
- [ ] For each worktree: check last activity by querying blackboard events with matching worktree path
- [ ] If no activity in `staleness_days`: remove via `removeWorktree()`, log event
- [ ] Return 'ok' with count of cleaned worktrees, or 'alert' if cleanup failures
- [ ] Injectable blackboard accessor (same pattern as github-issues evaluator)

## T-9: Add pipeline API endpoint (src/serve/api/specflow-pipeline.ts)
- [ ] `GET /api/specflow/pipelines` — returns pipeline status per feature
- [ ] SQL query: group work items by `specflow_feature_id` from metadata JSON
- [ ] For each feature: extract phase progression (completed phases, current phase, pending phases)
- [ ] Include: feature_id, feature_name, current_phase, phase_statuses[], worktree_path, created_at, last_activity
- [ ] Return JSON array

## T-10: Add pipeline dashboard panel (src/serve/views/specflow-panel.ts)
- [ ] HTML template function returning pipeline visualization
- [ ] Per-feature row: feature name → phase progression (specify ✓ → plan ✓ → tasks ○ → implement ○)
- [ ] Color coding: completed=green, in-progress=blue, pending=grey, failed=red
- [ ] Mount panel in dashboard (`src/serve/server.ts`) alongside existing panels
- [ ] Auto-refresh with existing 30s interval

## T-11: Write tests — specflow runner (test/specflow-runner.test.ts)
- [ ] Mock `Bun.spawn` to simulate specflow CLI responses
- [ ] Test specify phase: creates worktree, calls `specflow specify --batch`, checks gate
- [ ] Test plan phase: reuses worktree from metadata, calls `specflow plan`
- [ ] Test tasks phase: calls `specflow tasks`, chains implement
- [ ] Test implement phase: calls `specflow implement`, runs git ops (commit/push/PR)
- [ ] Test complete phase: calls `specflow complete`, removes worktree
- [ ] Test quality gate pass: score ≥ 80% → chain next phase
- [ ] Test quality gate fail (first attempt): retry_count=0 → create retry item with feedback
- [ ] Test quality gate fail (max retries): retry_count=1 → mark failed, no retry
- [ ] Test work item chaining: verify metadata inheritance (feature_id, worktree_path, priority)
- [ ] Test specflow CLI timeout: SIGTERM sent, work item released
- [ ] Test implement with no changes: complete without PR

## T-12: Write tests — CLI and cleanup (test/specflow-queue.test.ts, test/specflow-cleanup.test.ts)
- [ ] specflow-queue: valid project + feature → creates work item
- [ ] specflow-queue: project without specflow_enabled → error
- [ ] specflow-queue: nonexistent project → error
- [ ] specflow-queue: duplicate work item → error
- [ ] specflow-cleanup: stale worktree → removed, event logged
- [ ] specflow-cleanup: active worktree (recent work items) → preserved
- [ ] specflow-cleanup: cleanup failure → logged, returns alert
- [ ] specflow-cleanup: no worktrees → returns ok
