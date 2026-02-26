# F-027: SpecFlow State Machine Redesign

## Overview

The current SpecFlow dispatch pipeline is brittle because feature lifecycle state is encoded in work item metadata and chained between phases by creating new work items. This creates 7 distinct failure modes. This feature replaces the distributed phase-chaining architecture with a centralized `specflow_features` table and a single orchestrator that acts as the true state machine.

**Repos affected:** `ivy-blackboard` (new DB table + CRUD), `ivy-heartbeat` (orchestrator, phase executors, evaluator)

## Problem Statement

SpecFlow features can get stuck, repeat phases, or produce docs-only PRs. The root cause is architectural: work items were designed for independent tasks, not multi-phase pipelines. Using the work item queue as a state machine means:

- State is **copied** between items (lossy — metadata fields can be dropped)
- No **single record** of a feature's full lifecycle
- Failed phases create **orphaned work items** with stale metadata
- The scheduler must **parse metadata to route** (growing if/else chain)
- No quality gate on implement phase (exit code 0 ≠ code was written)

### Failure Mode Catalog

| ID | Symptom | Root Cause |
|----|---------|-----------|
| FM-1 | Feature stuck in "claimed" forever | Stale timeout releases claim but doesn't retry |
| FM-2 | Phase runs again after already succeeding | Double work item creation on crash between phases |
| FM-3 | PR contains only docs, no source code | Exit code 0 doesn't guarantee code was written |
| FM-4 | No single view of feature status | State distributed across N work items |
| FM-5 | Phase N+1 missing data from phase N | `chainNextPhase()` only copies specific fields |
| FM-6 | Low-quality artifacts advance to next phase | Only specify/plan phases have quality gates |
| FM-7 | Any change risks breaking all phases | `specflow-runner.ts` is 1546-line monolith |

## Users & Stakeholders

- **Primary user:** PAI operator (Jens-Christian) — wants reliable feature delivery without manual intervention
- **Pipeline maintainer:** Jens-Christian — wants maintainable, debuggable code
- **SpecFlow consumers:** Future agents implementing features — want correct context injected

## User Scenarios

### Scenario 1: Feature Progresses Automatically Through All Phases

**Given:** A feature `F-027` is queued in `specflow_features` with phase=`queued`
**When:** The orchestrator evaluator runs on each heartbeat cycle
**Then:** The feature advances through: queued → specifying → specified → planning → planned → tasking → tasked → implementing → implemented → completing → completed
**And:** Each phase transition is recorded as a blackboard event with timestamp and eval score
**And:** No manual intervention is required at any phase

### Scenario 2: Stuck Phase Automatically Recovers

**Given:** Feature F-027 is in phase `implementing` with `current_session` set and `phase_started_at` = 45 minutes ago (timeout = 30 min)
**When:** The orchestrator evaluator runs
**Then:** The orchestrator detects the stale session
**And:** Increments `failure_count`, clears `current_session`
**And:** Resets phase to `tasked` (the last succeeded phase)
**And:** Feature retries on the next heartbeat cycle

### Scenario 3: Docs-Only Implementation Blocked by Code Gate

**Given:** The implement phase agent exits with code 0 but only created `.specify/` artifacts
**When:** The orchestrator evaluates the phase result
**Then:** `code-gate.ts` runs `git diff --stat` and finds no non-spec source files changed
**And:** The feature phase does NOT advance to `implemented`
**And:** `failure_count` is incremented
**And:** An event is logged: "Code gate failed: no source changes detected"

### Scenario 4: Central Feature View

**Given:** Multiple features are in various lifecycle stages
**When:** The operator runs `GET /api/specflow`
**Then:** All features are returned with their current `phase`, `status`, `failure_count`, and eval scores
**And:** Each feature's full event history is available at `GET /api/specflow/:featureId/events`

### Scenario 5: Rollback to Old Flow

**Given:** The orchestrator has a bug that blocks a feature
**When:** The operator sets `SPECFLOW_ORCHESTRATOR=false` in the heartbeat config
**Then:** The old `agent_dispatch` evaluator resumes control
**And:** In-flight features continue via the old chainNextPhase flow (Phase 2 dual-write ensures the old flow is still intact)

## Functional Requirements

### FR-1: `specflow_features` Table in ivy-blackboard

**Requirement:** A new `specflow_features` table must exist in the blackboard SQLite database.

**Schema:**
```sql
CREATE TABLE specflow_features (
  feature_id       TEXT PRIMARY KEY,       -- e.g., "F-023"
  project_id       TEXT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  phase            TEXT NOT NULL DEFAULT 'queued',
  status           TEXT NOT NULL DEFAULT 'pending',
  current_session  TEXT,                   -- active agent session_id (null = not running)
  worktree_path    TEXT,
  branch_name      TEXT,
  main_branch      TEXT DEFAULT 'main',
  failure_count    INTEGER NOT NULL DEFAULT 0,
  max_failures     INTEGER NOT NULL DEFAULT 3,
  last_error       TEXT,
  last_phase_error TEXT,
  specify_score    INTEGER,                -- eval score (0-100)
  plan_score       INTEGER,
  implement_score  INTEGER,
  pr_number        INTEGER,
  pr_url           TEXT,
  commit_sha       TEXT,
  github_issue_number INTEGER,
  github_issue_url    TEXT,
  github_repo         TEXT,
  source              TEXT NOT NULL DEFAULT 'specflow',
  source_ref          TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  phase_started_at TEXT,
  completed_at     TEXT
);
```

**Phase values (state machine):**
```
queued → specifying → specified → planning → planned →
  tasking → tasked → implementing → implemented →
  completing → completed | failed | blocked
```

**Status values:** `pending | active | succeeded | failed | blocked`

### FR-2: Blackboard CRUD Methods

**Requirement:** The Blackboard class must expose CRUD methods for `specflow_features`.

**Methods:**
- `createFeature(data: CreateFeatureInput): SpecFlowFeature`
- `getFeature(featureId: string): SpecFlowFeature | null`
- `updateFeature(featureId: string, updates: Partial<SpecFlowFeature>): SpecFlowFeature`
- `listFeatures(opts?: { projectId?: string; phase?: string; status?: string }): SpecFlowFeature[]`
- `getActionableFeatures(maxConcurrent: number): SpecFlowFeature[]` — returns features the orchestrator can act on

**Location:** `ivy-blackboard/src/specflow-features.ts` + exposed via `Blackboard` class

### FR-3: Dual-Write from Existing Flow (Phase 2)

**Requirement:** During migration, the existing `specflow-runner.ts` must write to `specflow_features` on every phase execution without changing dispatch control.

**Specification:**
- On phase start: `updateFeature(id, { phase: 'specifying', status: 'active', current_session: sessionId })`
- On phase success: `updateFeature(id, { phase: 'specified', status: 'succeeded', specify_score: score })`
- On phase failure: `updateFeature(id, { status: 'failed', failure_count: count + 1, last_error: msg })`
- Dual-write is non-breaking — if it fails, log but don't abort the phase

### FR-4: SpecFlow Orchestrator (`specflow-orchestrator.ts`)

**Requirement:** A new orchestrator replaces the dispatch→specflow-runner→chainNextPhase flow.

**File location:** `src/scheduler/specflow/orchestrator.ts`

**Behavior:**
1. Query `getActionableFeatures()` from blackboard
2. Release stuck features (sessions older than `phase_timeout_min`)
3. For each actionable feature, call `determineAction(feature)` → run appropriate handler
4. Update `specflow_features` with results (no chainNextPhase, no new work items for phases)
5. Return summary: features advanced, stuck released, failed

**Action determination:**
| Feature state | Action |
|--------------|--------|
| `status=active`, session exists, not stale | `wait` |
| `status=active`, session stale | `release` |
| Phase ends with `ing`, `status=succeeded` | `check-gate` |
| Phase ends with `ed`, `status=pending` | `advance` |
| `status=pending` | `run-phase` |
| `failure_count >= max_failures` | `fail` |

### FR-5: Phase Executors (Decomposed)

**Requirement:** Each SpecFlow phase becomes a focused executor file following a common interface.

**Interface:**
```typescript
interface PhaseExecutor {
  canRun(feature: SpecFlowFeature, bb: Blackboard): Promise<boolean>;
  execute(feature: SpecFlowFeature, bb: Blackboard, session: string): Promise<PhaseResult>;
}

interface PhaseResult {
  status: 'succeeded' | 'failed';
  error?: string;
  artifacts?: string[];
  sourceChanges?: boolean;   // FM-3 prevention
  evalScore?: number;
}
```

**Files:**
```
src/scheduler/specflow/phases/
  specify.ts      -- specflow specify CLI + eval
  plan.ts         -- specflow plan CLI + eval
  tasks.ts        -- specflow tasks CLI
  implement.ts    -- Claude session launcher
  complete.ts     -- validate, commit, push, PR
```

**Constraint:** Executors NEVER call `chainNextPhase()` or modify feature phase. Return result only.

### FR-6: Code Gate (FM-3 Prevention)

**Requirement:** A code gate must run between `implementing` and `implemented` that verifies actual source code was modified.

**File:** `src/scheduler/specflow/gates/code-gate.ts`

**Specification:**
- Run `git diff --stat HEAD` in the worktree
- Filter output to exclude: `.specify/`, `CHANGELOG.md`, `Plans/`, `docs/`, `README.md`, `.claude/`, `verify.md`
- If zero non-excluded files changed: gate fails
- Gate failure: increment `failure_count`, log event, do NOT advance phase

### FR-7: Quality Gate Enforcement (FM-6 Prevention)

**Requirement:** Every phase transition must pass its gate before advancing. Gates for all phases, not just specify/plan.

**Gate requirements:**
| Phase | Gate | Condition |
|-------|------|-----------|
| specifying → specified | Eval | score >= 80 AND spec.md exists |
| planning → planned | Eval | score >= 80 AND plan.md exists |
| tasking → tasked | Artifact | tasks.md exists |
| implementing → implemented | Code gate | Non-spec source changes exist |
| completing → completed | Artifact | PR created, pr_number set |

### FR-8: SpecFlow Orchestrate Evaluator

**Requirement:** A new evaluator type `specflow_orchestrate` must trigger `orchestrateSpecFlow()` on each heartbeat.

**File:** `src/evaluators/specflow-orchestrate.ts`

**Heartbeat config:**
```yaml
- name: "SpecFlow Orchestrator"
  type: specflow_orchestrate
  config:
    max_concurrent: 4
    phase_timeout_min: 30
    feature_flag: SPECFLOW_ORCHESTRATOR  # env var toggle
```

**Behavior:** Calls `orchestrateSpecFlow(bb, opts)`. Non-specflow work items still route through existing `agent_dispatch` evaluator.

### FR-9: API Endpoints for Feature Visibility

**Requirement:** Three new REST endpoints for feature lifecycle visibility.

**Endpoints:**
- `GET /api/specflow` — list all features with phase/status/scores
- `GET /api/specflow/:featureId` — feature detail including worktree path, PR URL, failure history
- `GET /api/specflow/:featureId/events` — event timeline for a specific feature

**Response format:** JSON matching `SpecFlowFeature` type + events array

### FR-10: Audit Events at Every Transition

**Requirement:** The orchestrator must emit a blackboard event at every phase transition.

**Event format:**
```typescript
bb.appendEvent({
  actorId: 'specflow-orchestrator',
  targetId: feature.feature_id,
  summary: `Phase transition: ${fromPhase} → ${toPhase}`,
  metadata: {
    fromPhase, toPhase, reason,
    evalScore, failureCount,
    sessionId, durationMs
  },
});
```

### FR-11: Feature Registration from GitHub Issues

**Requirement:** The `github-issues.ts` evaluator must create entries in `specflow_features` when it detects a new GitHub issue with the `specflow` label (in addition to creating a work item).

**This replaces the work item as the source of truth for feature lifecycle.**

### FR-12: Backward Compatibility (Phase 4 Toggle)

**Requirement:** A feature flag `SPECFLOW_ORCHESTRATOR=true/false` must enable/disable the new orchestrator. When disabled, the old `agent_dispatch` + `chainNextPhase` flow continues unchanged.

**Implementation:** The `specflow_orchestrate` evaluator checks `process.env.SPECFLOW_ORCHESTRATOR !== 'true'` and exits early if not enabled.

## Non-Functional Requirements

### NFR-1: No Breaking Changes to In-Flight Features

During Phase 2 (dual-write), existing in-flight features must continue working via the old flow. The `specflow_features` table is populated but not controlling execution.

### NFR-2: Single Writer Rule

Only the orchestrator writes to `specflow_features.phase`. Phase executors read the feature row but never write `phase` directly — they return results.

### NFR-3: SQLite Concurrency

`specflow_features` writes must be atomic. Use SQLite transactions for multi-column updates. WAL mode (already enabled in ivy-blackboard) handles concurrent reads.

### NFR-4: Orchestrator Is Stateless

The orchestrator reads `specflow_features`, acts, updates. No in-memory state. Crashes are recoverable on the next heartbeat cycle.

### NFR-5: specflow-runner.ts Shrinks

After Phase 5 cleanup, `specflow-runner.ts` should be under 300 lines (down from 1546). Phase-specific logic moves to phase executor files.

## Success Criteria

1. **No stuck features** — Stale sessions are automatically released and retried within one heartbeat cycle
2. **No re-work** — Each phase runs at most `max_failures` times before failing, never infinitely
3. **No docs-only PRs** — Code gate blocks advancement if no source code changed
4. **Central feature view** — `/api/specflow` shows all features with full lifecycle state
5. **No lossy metadata** — Feature row persists all phase data without copying between work items
6. **All phases gated** — Every transition requires artifact + quality conditions
7. **Maintainable code** — Phase executors under 200 lines each; orchestrator under 300 lines

## Out of Scope

- Changes to specflow CLI (this is a pipeline/orchestration change)
- Review/rework/reflect phases (these use the existing work item flow, not specflow phases)
- Multi-project orchestration (single project per orchestrator call)
- Dashboard UI for specflow features (API only; dashboard HTML in separate feature)

## Assumptions

- ivy-blackboard supports SQLite migrations (already does via schema-version.ts)
- The blackboard WAL mode is enabled (confirmed in ivy-blackboard/src/db.ts)
- `specflow specify`, `specflow plan`, `specflow tasks` CLIs continue to work as-is
- Existing worktree management code in `specflow-runner.ts` is extracted as-is

## References

- PRD: `/Users/fischer/Plans/specflow-state-redesign.md`
- Current implementation: `src/scheduler/specflow-runner.ts`
- Phase types: `src/scheduler/specflow-types.ts`
- Blackboard: `~/work/ivy-blackboard/src/`
