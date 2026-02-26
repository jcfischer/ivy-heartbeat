# Implementation Tasks: F-027 SpecFlow State Machine Redesign

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| **Phase 1: Database Layer (ivy-blackboard)** | | |
| T-1.1 | ☐ | Determine migration number |
| T-1.2 | ☐ | Schema migration SQL |
| T-1.3 | ☐ | TypeScript types + Zod |
| T-1.4 | ☐ | createFeature() |
| T-1.5 | ☐ | getFeature() |
| T-1.6 | ☐ | updateFeature() |
| T-1.7 | ☐ | listFeatures() |
| T-1.8 | ☐ | getActionableFeatures() |
| T-1.9 | ☐ | Blackboard class integration |
| T-1.10 | ☐ | CRUD unit tests |
| T-1.11 | ☐ | Migration verification |
| **Phase 2: Dual-Write Bridge** | | |
| T-2.1 | ☐ | github-issues feature creation |
| T-2.2 | ☐ | Dual-write at phase start |
| T-2.3 | ☐ | Dual-write at phase success |
| T-2.4 | ☐ | Dual-write at phase failure |
| T-2.5 | ☐ | GET /api/specflow endpoint |
| T-2.6 | ☐ | GET /api/specflow/:id endpoint |
| T-2.7 | ☐ | GET /api/specflow/:id/events |
| T-2.8 | ☐ | Manual verification |
| **Phase 3: Orchestrator Core** | | |
| T-3.1 | ☐ | Directory structure |
| T-3.2 | ☐ | Extract worktree infra |
| T-3.3 | ☐ | Extract CLI spawner infra |
| T-3.4 | ☐ | Orchestrator types |
| T-3.5 | ☐ | Quality gate logic |
| T-3.6 | ☐ | Code gate (FM-3 fix) |
| T-3.7 | ☐ | Specify phase executor |
| T-3.8 | ☐ | Plan phase executor |
| T-3.9 | ☐ | Tasks phase executor |
| T-3.10 | ☐ | Implement phase executor |
| T-3.11 | ☐ | Complete phase executor |
| T-3.12 | ☐ | determineAction() |
| T-3.13 | ☐ | releaseStuckFeatures() |
| T-3.14 | ☐ | runPhase() |
| T-3.15 | ☐ | checkGate + advancePhase |
| T-3.16 | ☐ | orchestrateSpecFlow() main |
| T-3.17 | ☐ | Orchestrate evaluator |
| T-3.18 | ☐ | Orchestrator tests |
| T-3.19 | ☐ | Code gate tests |
| T-3.20 | ☐ | Evaluator registration |
| **Phase 4: Switchover** | | |
| T-4.1 | ☐ | Feature flag setup |
| T-4.2 | ☐ | Heartbeat config |
| T-4.3 | ☐ | No-op chainNextPhase |
| T-4.4 | ☐ | Smoke test |
| T-4.5 | ☐ | Monitor cycles |
| **Phase 5: Cleanup** | | |
| T-5.1 | ☐ | Delete chain functions |
| T-5.2 | ☐ | Remove phase blocks |
| T-5.3 | ☐ | Remove dual-write code |
| T-5.4 | ☐ | Verify line count |
| T-5.5 | ☐ | Update CHANGELOG |
| T-5.6 | ☐ | Final regression test |

---

## Phase 1: Database Layer (ivy-blackboard)

**Goal:** New `specflow_features` table with CRUD methods. No changes to dispatch flow.
**Effort:** ~2h
**Repo:** ivy-blackboard

### T-1.1: Determine next migration number
- **File:** ~/work/ivy-blackboard/src/migrations/
- **Test:** N/A
- **Dependencies:** none
- **Description:** Check `src/migrations/` for the highest numbered migration file. The next migration will be sequentially numbered (e.g., 006 if current is 005).

### T-1.2: Write SQL migration for specflow_features table [T]
- **File:** ~/work/ivy-blackboard/src/migrations/006-specflow-features.sql
- **Test:** T-1.11 verifies migration applies
- **Dependencies:** T-1.1
- **Description:** Create migration with full DDL from spec FR-1. Include: all 28 columns, CHECK constraints for phase enum (13 values) and status enum (5 values), DEFAULT values, indexes on project_id/phase/status/current_session, FOREIGN KEY constraints (project_id → projects, current_session → agents).

### T-1.3: Create TypeScript types and Zod schemas [T]
- **File:** ~/work/ivy-blackboard/src/specflow-features.ts
- **Test:** ~/work/ivy-blackboard/tests/specflow-features.test.ts
- **Dependencies:** T-1.2
- **Description:** Define: `SpecFlowFeaturePhase` (13 literal types: queued through blocked), `SpecFlowFeatureStatus` (5 literal types), `SpecFlowFeature` interface (28 columns), `SpecFlowFeatureSchema` Zod validator, `CreateFeatureInput` (required: feature_id, project_id, title), `UpdateFeatureInput` (all optional), `ListFeaturesOptions` interface.

### T-1.4: Implement createFeature() function [T]
- **File:** ~/work/ivy-blackboard/src/specflow-features.ts
- **Test:** ~/work/ivy-blackboard/tests/specflow-features.test.ts
- **Dependencies:** T-1.3
- **Description:** INSERT new row with validated input. Set defaults: phase='queued', status='pending', failure_count=0, max_failures=3, main_branch='main', source='specflow'. Return the created `SpecFlowFeature`. Throw if feature_id already exists.

### T-1.5: Implement getFeature() function [T]
- **File:** ~/work/ivy-blackboard/src/specflow-features.ts
- **Test:** ~/work/ivy-blackboard/tests/specflow-features.test.ts
- **Dependencies:** T-1.3
- **Description:** Query by feature_id. Return `SpecFlowFeature | null`. Validate row against Zod schema before returning. Log warning if row fails validation.

### T-1.6: Implement updateFeature() function [T]
- **File:** ~/work/ivy-blackboard/src/specflow-features.ts
- **Test:** ~/work/ivy-blackboard/tests/specflow-features.test.ts
- **Dependencies:** T-1.3
- **Description:** Build dynamic UPDATE with only specified fields. Always set `updated_at = datetime('now')`. Return updated feature. Throw if feature_id not found.

### T-1.7: Implement listFeatures() function [T]
- **File:** ~/work/ivy-blackboard/src/specflow-features.ts
- **Test:** ~/work/ivy-blackboard/tests/specflow-features.test.ts
- **Dependencies:** T-1.3
- **Description:** Support optional filters: projectId, phase, status, limit. Build WHERE clause dynamically. Return all matching features ordered by created_at DESC.

### T-1.8: Implement getActionableFeatures() function [T]
- **File:** ~/work/ivy-blackboard/src/specflow-features.ts
- **Test:** ~/work/ivy-blackboard/tests/specflow-features.test.ts
- **Dependencies:** T-1.3
- **Description:** Return features the orchestrator can act on. Query for: (a) status='pending' (needs run), (b) status='succeeded' AND phase LIKE '%ing' (needs gate check), (c) status='succeeded' AND phase LIKE '%ed' (needs advance), (d) status='active' (needs stale check). Exclude terminal phases: completed, failed, blocked. Limit to maxConcurrent parameter.

### T-1.9: Integrate with Blackboard class [T]
- **File:** ~/work/ivy-blackboard/src/blackboard.ts
- **Secondary:** ~/work/ivy-blackboard/src/index.ts
- **Test:** ~/work/ivy-blackboard/tests/specflow-features.test.ts
- **Dependencies:** T-1.4, T-1.5, T-1.6, T-1.7, T-1.8
- **Description:** Add 5 methods to Blackboard class that delegate to specflow-features.ts functions. Export types and functions from index.ts. Update CURRENT_SCHEMA_VERSION constant and migration runner.

### T-1.10: CRUD unit tests [T]
- **File:** ~/work/ivy-blackboard/tests/specflow-features.test.ts
- **Test:** N/A (is tests)
- **Dependencies:** T-1.9
- **Description:** Test suite covering: createFeature creates row with defaults, createFeature rejects duplicate feature_id, getFeature returns null for missing, getFeature validates schema, updateFeature updates only specified fields, updateFeature always updates updated_at, listFeatures filters correctly, getActionableFeatures returns correct features for each action type, phase transition validation.

### T-1.11: Verify migration runs without error
- **File:** N/A (verification)
- **Test:** `bun test` in ivy-blackboard
- **Dependencies:** T-1.10
- **Description:** Run `bun test` in ivy-blackboard. Confirm migration applies cleanly. Verify table exists with correct schema. Run CRUD tests. Fix any issues before proceeding to Phase 2.

---

## Phase 2: Dual-Write Bridge

**Goal:** Existing flow writes to `specflow_features` as audit log. Old flow still controls execution.
**Effort:** ~2h
**Repo:** ivy-heartbeat

### T-2.1: Add feature creation to github-issues.ts [T] [P with T-2.2, T-2.3, T-2.4]
- **File:** src/evaluators/github-issues.ts
- **Test:** Manual (T-2.8)
- **Dependencies:** T-1.11 (Phase 1 complete)
- **Description:** When creating a specflow work item (GitHub issue with specflow label), also call `bb.createFeature({ feature_id, project_id, title, description: issue body, github_issue_number, github_issue_url, github_repo, source: 'github' })`. Wrap in try/catch — failure logs warning but doesn't abort work item creation.

### T-2.2: Add dual-write at phase start [T] [P with T-2.1, T-2.3, T-2.4]
- **File:** src/scheduler/specflow-runner.ts
- **Test:** Manual (T-2.8)
- **Dependencies:** T-1.11
- **Description:** In `runSpecFlowPhase()`, after work item is claimed, add: `bb.updateFeature(featureId, { phase: phaseName + 'ing', status: 'active', current_session: sessionId, phase_started_at: new Date().toISOString() })`. Add helper `ensureFeatureRow()` that creates row if missing (for features created before Phase 2). Wrap in try/catch, log failure but continue.

### T-2.3: Add dual-write at phase success [T] [P with T-2.1, T-2.2, T-2.4]
- **File:** src/scheduler/specflow-runner.ts
- **Test:** Manual (T-2.8)
- **Dependencies:** T-1.11
- **Description:** After quality gate passes and before `chainNextPhase()`, add: `bb.updateFeature(featureId, { phase: phaseName + 'ed', status: 'succeeded', [phase + '_score']: evalScore })`. For complete phase, also update: pr_number, pr_url, commit_sha, completed_at. Wrap in try/catch.

### T-2.4: Add dual-write at phase failure [T] [P with T-2.1, T-2.2, T-2.3]
- **File:** src/scheduler/specflow-runner.ts
- **Test:** Manual (T-2.8)
- **Dependencies:** T-1.11
- **Description:** After quality gate fails or agent exits non-zero, add: `bb.updateFeature(featureId, { status: 'failed', failure_count: currentCount + 1, last_error: errorMsg, last_phase_error: phaseName })`. Wrap in try/catch.

### T-2.5: Add GET /api/specflow endpoint [T]
- **File:** src/server.ts
- **Test:** tests/server.test.ts
- **Dependencies:** T-1.11
- **Description:** Add route `GET /api/specflow` that calls `bb.listFeatures(query)` with optional query params: project, phase, status, limit. Return JSON: `{ features: SpecFlowFeature[], total: number, hasMore: boolean }`.

### T-2.6: Add GET /api/specflow/:featureId endpoint [T]
- **File:** src/server.ts
- **Test:** tests/server.test.ts
- **Dependencies:** T-1.11
- **Description:** Add route `GET /api/specflow/:featureId` that calls `bb.getFeature(featureId)`. Return feature JSON or 404.

### T-2.7: Add GET /api/specflow/:featureId/events endpoint [T]
- **File:** src/server.ts
- **Test:** tests/server.test.ts
- **Dependencies:** T-1.11
- **Description:** Add route `GET /api/specflow/:featureId/events` that queries events table for targetId = featureId, ordered by created_at DESC. Return JSON: `{ events: BlackboardEvent[], feature: SpecFlowFeature }`.

### T-2.8: Manual dual-write verification
- **File:** N/A (manual testing)
- **Test:** N/A
- **Dependencies:** T-2.1, T-2.2, T-2.3, T-2.4, T-2.5, T-2.6, T-2.7
- **Description:** Queue a real feature via GitHub issue or `specflow specify`. Run one full dispatch cycle. Verify: specflow_features row exists, phase progresses correctly (queued → specifying → specified), status transitions (pending → active → succeeded), scores captured, timestamps update. Check `/api/specflow` returns the feature. Document in verify.md.

---

## Phase 3: Orchestrator Core

**Goal:** New orchestrator built and tested, running alongside old flow.
**Effort:** ~4h
**Repo:** ivy-heartbeat

### T-3.1: Create directory structure
- **File:** src/scheduler/specflow/
- **Test:** N/A
- **Dependencies:** T-2.8 (Phase 2 complete)
- **Description:** Create directory structure:
  ```
  src/scheduler/specflow/
    orchestrator.ts
    orchestrator-types.ts
    types.ts
    executor-registry.ts
    phases/
      specify.ts
      plan.ts
      tasks.ts
      implement.ts
      complete.ts
    gates/
      quality-gate.ts
      code-gate.ts
      artifact-gate.ts
    infra/
      worktree.ts
      specflow-cli.ts
  ```

### T-3.2: Extract worktree infra [T] [P with T-3.3]
- **File:** src/scheduler/specflow/infra/worktree.ts
- **Test:** tests/specflow-infra.test.ts
- **Dependencies:** T-3.1
- **Description:** Extract from specflow-runner.ts: `ensureWorktree(projectPath, branchName, mainBranch)`, `cleanupWorktree(worktreePath)`, `hasCommitsAhead(worktreePath, mainBranch)`, `getCurrentBranch(worktreePath)`, `resolveWorktreePath()`. Update existing imports in specflow-runner.ts to use new location. Keep backward compatibility.

### T-3.3: Extract CLI spawner infra [T] [P with T-3.2]
- **File:** src/scheduler/specflow/infra/specflow-cli.ts
- **Test:** tests/specflow-infra.test.ts
- **Dependencies:** T-3.1
- **Description:** Extract from specflow-runner.ts: `runSpecflowCli(command, args, cwd, timeout)` → `{ stdout, stderr, exitCode }`, `parseEvalScore(stdout)` → number. Use Bun.spawn with timeout. Verify `bun test` still passes.

### T-3.4: Create orchestrator types [T]
- **File:** src/scheduler/specflow/orchestrator-types.ts
- **Test:** Compile-time
- **Dependencies:** T-3.1
- **Description:** Define: `OrchestratorAction` discriminated union (wait/release/advance/run-phase/check-gate/fail with reason fields), `OrchestratorConfig` (maxConcurrent, phaseTimeoutMin, featureFlag), `OrchestratorResult` (featuresProcessed/Advanced/Released/Failed + errors array), `PHASE_TRANSITIONS` map.

### T-3.5: Create quality gate [T] [P with T-3.6]
- **File:** src/scheduler/specflow/gates/quality-gate.ts
- **Test:** tests/specflow-gates.test.ts
- **Dependencies:** T-3.4
- **Description:** Implement `checkQualityGate(feature, evalScore, threshold)` → `{ passed: boolean, score: number, reason: string }`. Export `PHASE_EVAL_THRESHOLDS`: specify=80, plan=80. Gate passes if score >= threshold.

### T-3.6: Create code gate (FM-3 fix) [T] [P with T-3.5]
- **File:** src/scheduler/specflow/gates/code-gate.ts
- **Test:** tests/specflow-gates.test.ts
- **Dependencies:** T-3.4
- **Description:** Implement `checkCodeGate(worktreePath)` → `{ passed: boolean, changedFiles: string[], reason: string }`. Run `git diff --stat HEAD` in worktreePath. Filter out CODE_GATE_EXCLUSIONS: `.specify/`, `CHANGELOG.md`, `Plans/`, `docs/`, `README.md`, `.claude/`, `verify.md`, `.specflow/`. Gate fails if zero non-excluded files changed. This directly fixes FM-3.

### T-3.7: Create specify phase executor [T] [P with T-3.8, T-3.9]
- **File:** src/scheduler/specflow/phases/specify.ts
- **Test:** tests/specflow-phases.test.ts
- **Dependencies:** T-3.2, T-3.3, T-3.5
- **Description:** Implement `SpecifyExecutor` class with PhaseExecutor interface. `canRun()`: check phase is 'specifying'. `execute()`: run `specflow specify` CLI via specflow-cli.ts, run eval, return PhaseResult with evalScore and artifacts. Keep under 200 lines.

### T-3.8: Create plan phase executor [T] [P with T-3.7, T-3.9]
- **File:** src/scheduler/specflow/phases/plan.ts
- **Test:** tests/specflow-phases.test.ts
- **Dependencies:** T-3.2, T-3.3, T-3.5
- **Description:** Implement `PlanExecutor` class with PhaseExecutor interface. `canRun()`: check phase is 'planning'. `execute()`: run `specflow plan` CLI, run eval, return PhaseResult. Keep under 200 lines.

### T-3.9: Create tasks phase executor [T] [P with T-3.7, T-3.8]
- **File:** src/scheduler/specflow/phases/tasks.ts
- **Test:** tests/specflow-phases.test.ts
- **Dependencies:** T-3.2, T-3.3
- **Description:** Implement `TasksExecutor` class with PhaseExecutor interface. `canRun()`: check phase is 'tasking'. `execute()`: run `specflow tasks` CLI, return PhaseResult with artifacts (tasks.md). Keep under 200 lines.

### T-3.10: Create implement phase executor [T]
- **File:** src/scheduler/specflow/phases/implement.ts
- **Test:** tests/specflow-phases.test.ts
- **Dependencies:** T-3.2, T-3.3, T-3.6
- **Description:** Implement `ImplementExecutor` class. `canRun()`: check phase is 'implementing'. `execute()`: build prompt from spec/plan/tasks, launch `claude -p` session, capture output, run code gate, return PhaseResult with sourceChanges flag. Include dynamic timeout: `max(30min, taskCount × 3min)`. Inject "EXECUTION MODE: Direct Implementation" preamble. Keep under 200 lines.

### T-3.11: Create complete phase executor [T]
- **File:** src/scheduler/specflow/phases/complete.ts
- **Test:** tests/specflow-phases.test.ts
- **Dependencies:** T-3.2, T-3.3, T-3.6
- **Description:** Implement `CompleteExecutor` class. `canRun()`: check phase is 'completing'. `execute()`: validate implementation, commitAll, push branch, createPR with --head flag, create review work item, cleanup worktree, return PhaseResult with pr_number/pr_url in metadata. Keep under 200 lines.

### T-3.12: Implement determineAction() [T]
- **File:** src/scheduler/specflow/orchestrator.ts
- **Test:** tests/specflow-orchestrator.test.ts
- **Dependencies:** T-3.4
- **Description:** Implement `determineAction(feature)` → OrchestratorAction. Logic from spec Appendix B: terminal states → wait, blocked → wait, max failures → fail, active+stale → release, active+fresh → wait, ing+succeeded → check-gate, ed+pending → advance, pending → run-phase.

### T-3.13: Implement releaseStuckFeatures() [T]
- **File:** src/scheduler/specflow/orchestrator.ts
- **Test:** tests/specflow-orchestrator.test.ts
- **Dependencies:** T-3.12
- **Description:** Query features with status='active' and phase_started_at older than phase_timeout_min. For each: increment failure_count, clear current_session, reset phase to previous `*ed` state (e.g., implementing → tasked), set status='pending', emit blackboard event.

### T-3.14: Implement runPhase() [T]
- **File:** src/scheduler/specflow/orchestrator.ts
- **Test:** tests/specflow-orchestrator.test.ts
- **Dependencies:** T-3.7, T-3.8, T-3.9, T-3.10, T-3.11
- **Description:** For feature with action='run-phase': get executor from registry, set feature to active + current_session + phase_started_at, call executor.execute(), on result update feature phase/status/scores, emit transition event.

### T-3.15: Implement checkGate + advancePhase [T]
- **File:** src/scheduler/specflow/orchestrator.ts
- **Test:** tests/specflow-orchestrator.test.ts
- **Dependencies:** T-3.5, T-3.6
- **Description:** `checkGateAndAdvance(feature)`: determine gate for current phase (eval-gate for specify/plan, code-gate for implement, artifact-gate for tasks/complete), run gate, if passed advance phase (specifying→specified→planning, etc.) and set status='pending', if failed increment failure_count.

### T-3.16: Implement orchestrateSpecFlow() main [T]
- **File:** src/scheduler/specflow/orchestrator.ts
- **Test:** tests/specflow-orchestrator.test.ts
- **Dependencies:** T-3.12, T-3.13, T-3.14, T-3.15
- **Description:** Wire together: `getActionableFeatures(maxConcurrent)` → `releaseStuckFeatures()` → for each feature: `determineAction()` → dispatch to appropriate handler. Return `OrchestratorResult` with counts. Keep under 300 lines.

### T-3.17: Create specflow_orchestrate evaluator [T]
- **File:** src/evaluators/specflow-orchestrate.ts
- **Test:** tests/evaluators/specflow-orchestrate.test.ts
- **Dependencies:** T-3.16
- **Description:** New evaluator that calls `orchestrateSpecFlow(bb, config)`. Check `process.env.SPECFLOW_ORCHESTRATOR !== 'true'` at start — exit early if disabled. Config schema: maxConcurrent (default 4), phaseTimeoutMin (default 30). Return EvaluatorResult with summary.

### T-3.18: Write orchestrator tests [T]
- **File:** tests/specflow-orchestrator.test.ts
- **Test:** N/A (is tests)
- **Dependencies:** T-3.16
- **Description:** Test suite with mock Blackboard and mock executors: determineAction returns correct action for each state, releaseStuckFeatures handles timeout correctly, runPhase updates feature state, checkGateAndAdvance handles pass/fail, orchestrateSpecFlow processes multiple features, errors don't crash orchestrator.

### T-3.19: Write gate tests [T]
- **File:** tests/specflow-gates.test.ts
- **Test:** N/A (is tests)
- **Dependencies:** T-3.5, T-3.6
- **Description:** Test code gate with mock git output: only .specify/ files → fails, source + spec files → passes, empty diff → fails, only CHANGELOG → fails. Test eval gate: score >= threshold → passes, score < threshold → fails. Test artifact gate: file exists → passes, missing → fails.

### T-3.20: Register evaluator type [T]
- **File:** src/evaluators/index.ts
- **Test:** tests/evaluators.test.ts
- **Dependencies:** T-3.17
- **Description:** Add `specflow_orchestrate` to evaluator type registry. Export from index. Update evaluator config schema.

---

## Phase 4: Switchover

**Goal:** Enable orchestrator via feature flag and verify.
**Effort:** ~2h
**Repo:** ivy-heartbeat

### T-4.1: Configure feature flag
- **File:** .env.example, src/config.ts
- **Test:** Manual
- **Dependencies:** T-3.20 (Phase 3 complete)
- **Description:** Add `SPECFLOW_ORCHESTRATOR=false` to .env.example with documentation. Add to config schema with default false. Document in README.md. Do NOT set to true in committed files.

### T-4.2: Update heartbeat config
- **File:** heartbeat config (YAML/JSON)
- **Test:** Manual
- **Dependencies:** T-4.1
- **Description:** Add specflow_orchestrate evaluator entry with config: max_concurrent=4, phase_timeout_min=30, feature_flag='SPECFLOW_ORCHESTRATOR'. Keep existing agent_dispatch evaluator for non-specflow work items.

### T-4.3: No-op chainNextPhase()
- **File:** src/scheduler/specflow-runner.ts
- **Test:** Regression tests pass
- **Dependencies:** T-4.2
- **Description:** Replace chainNextPhase() implementation with: `console.warn('DEPRECATED: chainNextPhase() called but orchestrator is active.')`. Keep function signature for rollback capability. Do NOT delete yet.

### T-4.4: Smoke test with orchestrator
- **File:** N/A (manual testing)
- **Test:** N/A
- **Dependencies:** T-4.3
- **Description:** Set SPECFLOW_ORCHESTRATOR=true in local .env. Queue a minimal test feature. Verify it advances: queued → specifying → specified → planning → planned → tasking → tasked → implementing → implemented → completing → completed. Check /api/specflow shows lifecycle. Document in verify.md.

### T-4.5: Monitor for 2-3 dispatch cycles
- **File:** N/A (monitoring)
- **Test:** N/A
- **Dependencies:** T-4.4
- **Description:** Watch logs for: stuck features released, unexpected phase regressions, code gate false positives/negatives, dual-write errors. If issues found, set SPECFLOW_ORCHESTRATOR=false to rollback. Fix issues before Phase 5.

---

## Phase 5: Cleanup

**Goal:** Remove dead code, shrink specflow-runner.ts to ~200 lines.
**Effort:** ~1h
**Repo:** ivy-heartbeat

### T-5.1: Delete chain functions
- **File:** src/scheduler/specflow-runner.ts
- **Test:** Regression tests pass
- **Dependencies:** T-4.5 (orchestrator stable 2+ cycles)
- **Description:** Remove `chainNextPhase()` and `chainRetry()` functions entirely. Remove all callers.

### T-5.2: Remove phase execution blocks
- **File:** src/scheduler/specflow-runner.ts
- **Test:** Regression tests pass
- **Dependencies:** T-5.1
- **Description:** Remove per-phase execution code blocks (now in phases/*.ts). Keep only: imports, type re-exports, thin wrapper if needed for legacy.

### T-5.3: Remove dual-write code
- **File:** src/scheduler/specflow-runner.ts
- **Test:** Regression tests pass
- **Dependencies:** T-5.2
- **Description:** Remove Phase 2 try/catch dual-write blocks (now superseded by orchestrator direct writes).

### T-5.4: Verify line count target
- **File:** src/scheduler/specflow-runner.ts
- **Test:** `wc -l`
- **Dependencies:** T-5.3
- **Description:** Run `wc -l src/scheduler/specflow-runner.ts`. Target: under 300 lines (down from 1546). If longer, identify additional extractable code.

### T-5.5: Update CHANGELOG
- **File:** CHANGELOG.md
- **Test:** N/A
- **Dependencies:** T-5.4
- **Description:** Add entry for F-027: "SpecFlow state machine redesign — centralized specflow_features table (ivy-blackboard), orchestrator replaces chainNextPhase (FM-1/FM-2/FM-5 fixes), code gate prevents docs-only PRs (FM-3), all phases gated (FM-6), specflow-runner.ts reduced to ~200 lines (FM-7), /api/specflow visibility (FM-4)."

### T-5.6: Final regression test
- **File:** N/A (test run)
- **Test:** `bun test`
- **Dependencies:** T-5.5
- **Description:** Run `bun test`. Verify all 490+ tests pass (count may be higher with new tests). Run one feature end-to-end. Verify /api/specflow shows complete history. Confirm no stuck features.

---

## Execution Order

### Critical Path

```
Phase 1 (ivy-blackboard):
  T-1.1 → T-1.2 → T-1.3 → [T-1.4, T-1.5, T-1.6, T-1.7, T-1.8] → T-1.9 → T-1.10 → T-1.11

Phase 2 (ivy-heartbeat):
  [T-2.1, T-2.2, T-2.3, T-2.4] (parallel) → [T-2.5, T-2.6, T-2.7] (parallel) → T-2.8

Phase 3 (ivy-heartbeat):
  T-3.1 → [T-3.2, T-3.3] (parallel) → T-3.4
        ↓
  [T-3.5, T-3.6] (parallel, gates)
        ↓
  [T-3.7, T-3.8, T-3.9] (parallel, specify/plan/tasks)
        ↓
  T-3.10 (implement) → T-3.11 (complete)
        ↓
  T-3.12 → T-3.13 → T-3.14 → T-3.15 → T-3.16 (orchestrator core)
        ↓
  T-3.17 → [T-3.18, T-3.19] (parallel, tests) → T-3.20

Phase 4 (ivy-heartbeat):
  T-4.1 → T-4.2 → T-4.3 → T-4.4 → T-4.5

Phase 5 (ivy-heartbeat):
  T-5.1 → T-5.2 → T-5.3 → T-5.4 → T-5.5 → T-5.6
```

### Parallelization Opportunities

| Batch | Tasks | After |
|-------|-------|-------|
| 1 | T-1.4, T-1.5, T-1.6, T-1.7, T-1.8 | T-1.3 |
| 2 | T-2.1, T-2.2, T-2.3, T-2.4 | T-1.11 |
| 3 | T-2.5, T-2.6, T-2.7 | T-1.11 |
| 4 | T-3.2, T-3.3 | T-3.1 |
| 5 | T-3.5, T-3.6 | T-3.4 |
| 6 | T-3.7, T-3.8, T-3.9 | T-3.5 |
| 7 | T-3.18, T-3.19 | T-3.16 |

---

## Risk Mitigation

| Risk | Mitigation | Related Tasks |
|------|------------|---------------|
| Orchestrator bug blocks all features | Phase 2 dual-write keeps old flow functional | T-2.1-T-2.4, T-4.1 |
| SQLite contention | Single writer (orchestrator) + WAL mode | T-3.16 |
| Agent dies mid-phase | phase_started_at + timeout detection | T-3.13 |
| Code gate too aggressive | Explicit exclusion list, tunable | T-3.6, T-3.19 |
| In-flight features during migration | Phase 2 populates table first | T-2.8 |

---

## Effort Summary

| Phase | Tasks | Effort | Repo |
|-------|-------|--------|------|
| Phase 1 | T-1.1 to T-1.11 (11) | ~2h | ivy-blackboard |
| Phase 2 | T-2.1 to T-2.8 (8) | ~2h | ivy-heartbeat |
| Phase 3 | T-3.1 to T-3.20 (20) | ~4h | ivy-heartbeat |
| Phase 4 | T-4.1 to T-4.5 (5) | ~2h | ivy-heartbeat |
| Phase 5 | T-5.1 to T-5.6 (6) | ~1h | ivy-heartbeat |
| **Total** | **50 tasks** | **~11h** | — |
