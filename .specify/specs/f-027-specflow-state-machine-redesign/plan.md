# F-027: SpecFlow State Machine Redesign — Technical Plan

## Approach

5-phase migration from the current work-item-based phase chaining to a centralized `specflow_features` state machine. Each phase is independently deployable and non-breaking.

The core principle: **don't rewrite, decompose**. The same operations happen (worktree setup, specflow CLI, quality gates, git, PR) but they're controlled by one coordinator instead of a chain of independently-created work items.

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Project standard |
| Database | SQLite (bun:sqlite) | Existing pattern in ivy-blackboard |
| ORM | None (raw SQL) | Matches ivy-blackboard pattern |
| Testing | bun:test | Project standard |
| CLI | Commander.js | Existing specflow CLI pattern |
| Type Safety | TypeScript + Zod | Runtime validation for DB rows |

## Architecture Overview

### Current Flow
```
heartbeat → agent_dispatch evaluator → scheduler.ts
  → parse metadata (if/else chain)
  → specflow-runner.ts (1545 lines)
    → runs phase
    → chainNextPhase() → creates new work item
    → next heartbeat picks up new work item
```

### New Flow
```
heartbeat → specflow_orchestrate evaluator → orchestrator.ts
  → queries specflow_features table
  → determineAction() per feature
  → phase executor (specify.ts / plan.ts / etc.)
  → executor returns PhaseResult
  → orchestrator updates specflow_features row
  → next heartbeat picks up same feature (same row, new phase)
```

### System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           IVY-HEARTBEAT                                     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Heartbeat Runner                                                    │   │
│  │  ┌─────────────────────┐   ┌──────────────────────────────────────┐│   │
│  │  │ specflow_orchestrate│──▶│ SpecFlow Orchestrator               ││   │
│  │  │ evaluator           │   │                                      ││   │
│  │  └─────────────────────┘   │  ┌───────┐ ┌───────┐ ┌───────┐     ││   │
│  │                            │  │Release│ │Advance│ │RunPhase│     ││   │
│  │                            │  │Stuck  │ │State  │ │Handler│     ││   │
│  │                            │  └───────┘ └───────┘ └───────┘     ││   │
│  │                            │       │         │         │         ││   │
│  │                            │       └─────────┴─────────┘         ││   │
│  │                            │               │                     ││   │
│  │                            │               ▼                     ││   │
│  │                            │     ┌───────────────────┐           ││   │
│  │                            │     │ Phase Executors   │           ││   │
│  │                            │     │ specify/plan/     │           ││   │
│  │                            │     │ tasks/implement/  │           ││   │
│  │                            │     │ complete          │           ││   │
│  │                            │     └───────────────────┘           ││   │
│  │                            │               │                     ││   │
│  │                            │               ▼                     ││   │
│  │                            │     ┌───────────────────┐           ││   │
│  │                            │     │ Quality Gates     │           ││   │
│  │                            │     │ eval/code/artifact│           ││   │
│  │                            └─────┴───────────────────┴───────────┘│   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                       │                                     │
│                                       ▼                                     │
│                          ┌───────────────────────┐                          │
│                          │ Blackboard Client     │                          │
│                          │ (SpecFlow CRUD)       │                          │
│                          └───────────────────────┘                          │
│                                       │                                     │
└───────────────────────────────────────┼─────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           IVY-BLACKBOARD                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  SQLite Database                                                     │   │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │   │
│  │  │ specflow_features│  │ events          │  │ work_items      │     │   │
│  │  │ (NEW)            │  │ (existing)      │  │ (existing)      │     │   │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘     │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### State Machine Diagram

```
                                 ┌─────────────────┐
                                 │     queued      │
                                 └────────┬────────┘
                                          │
                                          ▼
                                 ┌─────────────────┐
                          ┌──────│   specifying    │──────┐
                          │      └────────┬────────┘      │
                          │ fail          │ pass          │ timeout
                          ▼               ▼               ▼
                   [retry]       ┌─────────────────┐  [release]
                                 │   specified     │
                                 └────────┬────────┘
                                          ▼
                                 ┌─────────────────┐
                                 │    planning     │
                                 └────────┬────────┘
                                          ▼
                                 ┌─────────────────┐
                                 │    planned      │
                                 └────────┬────────┘
                                          ▼
                                 ┌─────────────────┐
                                 │    tasking      │
                                 └────────┬────────┘
                                          ▼
                                 ┌─────────────────┐
                                 │    tasked       │
                                 └────────┬────────┘
                                          ▼
                                 ┌─────────────────┐
                          ┌──────│  implementing   │──────┐
                          │      └────────┬────────┘      │
                          │ fail+         │ pass+         │ timeout
                          │ code-gate     │ code-gate     │
                          ▼               ▼               ▼
                   [retry]       ┌─────────────────┐  [release]
                                 │  implemented    │
                                 └────────┬────────┘
                                          ▼
                                 ┌─────────────────┐
                                 │   completing    │
                                 └────────┬────────┘
                          ┌───────────────┴───────────────┐
                          ▼                               ▼
                 ┌─────────────────┐             ┌─────────────────┐
                 │   completed     │             │     failed      │
                 └─────────────────┘             └─────────────────┘
```

## Data Model

### New Table: `specflow_features`

```typescript
// ivy-blackboard/src/specflow-features.ts

import { z } from 'zod';

export type SpecFlowFeaturePhase =
  | 'queued'
  | 'specifying' | 'specified'
  | 'planning'   | 'planned'
  | 'tasking'    | 'tasked'
  | 'implementing' | 'implemented'
  | 'completing' | 'completed'
  | 'failed'
  | 'blocked';

export type SpecFlowFeatureStatus =
  | 'pending'
  | 'active'
  | 'succeeded'
  | 'failed'
  | 'blocked';

export interface SpecFlowFeature {
  feature_id: string;           // "F-027", "GH-123"
  project_id: string;           // FK to projects
  title: string;
  description: string | null;

  // State machine
  phase: SpecFlowFeaturePhase;
  status: SpecFlowFeatureStatus;
  current_session: string | null;  // Active agent session_id

  // Worktree tracking
  worktree_path: string | null;
  branch_name: string | null;
  main_branch: string;

  // Failure handling
  failure_count: number;
  max_failures: number;
  last_error: string | null;
  last_phase_error: string | null;

  // Quality scores
  specify_score: number | null;
  plan_score: number | null;
  implement_score: number | null;

  // PR tracking
  pr_number: number | null;
  pr_url: string | null;
  commit_sha: string | null;

  // GitHub integration
  github_issue_number: number | null;
  github_issue_url: string | null;
  github_repo: string | null;

  // Source tracking
  source: string;               // 'specflow', 'github', 'manual'
  source_ref: string | null;

  // Timestamps
  created_at: string;
  updated_at: string;
  phase_started_at: string | null;
  completed_at: string | null;
}

// Zod schema for runtime validation
export const SpecFlowFeatureSchema = z.object({
  feature_id: z.string(),
  project_id: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  phase: z.enum(['queued', 'specifying', 'specified', 'planning', 'planned',
                 'tasking', 'tasked', 'implementing', 'implemented',
                 'completing', 'completed', 'failed', 'blocked']),
  status: z.enum(['pending', 'active', 'succeeded', 'failed', 'blocked']),
  current_session: z.string().nullable(),
  worktree_path: z.string().nullable(),
  branch_name: z.string().nullable(),
  main_branch: z.string().default('main'),
  failure_count: z.number().default(0),
  max_failures: z.number().default(3),
  last_error: z.string().nullable(),
  last_phase_error: z.string().nullable(),
  specify_score: z.number().nullable(),
  plan_score: z.number().nullable(),
  implement_score: z.number().nullable(),
  pr_number: z.number().nullable(),
  pr_url: z.string().nullable(),
  commit_sha: z.string().nullable(),
  github_issue_number: z.number().nullable(),
  github_issue_url: z.string().nullable(),
  github_repo: z.string().nullable(),
  source: z.string().default('specflow'),
  source_ref: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  phase_started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});
```

### Phase Executor Interface

```typescript
// ivy-heartbeat/src/scheduler/specflow/types.ts

export interface PhaseExecutor {
  /** Check if this executor can run for the given feature */
  canRun(feature: SpecFlowFeature, bb: Blackboard): Promise<boolean>;

  /** Execute the phase, return result (never throws) */
  execute(
    feature: SpecFlowFeature,
    bb: Blackboard,
    sessionId: string,
    opts: PhaseExecutorOptions
  ): Promise<PhaseResult>;
}

export interface PhaseExecutorOptions {
  worktreePath: string;
  projectPath: string;
  timeoutMs: number;
}

export interface PhaseResult {
  status: 'succeeded' | 'failed';
  error?: string;
  artifacts?: string[];          // Files created
  sourceChanges?: boolean;       // For code gate
  evalScore?: number;            // Quality gate score
  metadata?: Record<string, unknown>;
}
```

### Orchestrator Types

```typescript
// ivy-heartbeat/src/scheduler/specflow/orchestrator-types.ts

export type OrchestratorAction =
  | { type: 'wait'; reason: string }
  | { type: 'release'; reason: string }
  | { type: 'advance'; fromPhase: string; toPhase: string }
  | { type: 'run-phase'; phase: string }
  | { type: 'check-gate'; gate: string }
  | { type: 'fail'; reason: string };

export interface OrchestratorConfig {
  maxConcurrent: number;        // Max features running simultaneously
  phaseTimeoutMin: number;      // Minutes before a phase is considered stuck
  featureFlag: string;          // Env var to check for enable/disable
}

export interface OrchestratorResult {
  featuresProcessed: number;
  featuresAdvanced: number;
  featuresReleased: number;
  featuresFailed: number;
  errors: Array<{ featureId: string; error: string }>;
}
```

## API Contracts

### REST Endpoints (ivy-heartbeat)

#### `GET /api/specflow`

List all SpecFlow features with current state.

**Request:**
```
GET /api/specflow?project=<project_id>&phase=<phase>&status=<status>&limit=50
```

**Response:**
```json
{
  "features": [
    {
      "feature_id": "F-027",
      "project_id": "ivy-heartbeat",
      "title": "SpecFlow State Machine Redesign",
      "phase": "implementing",
      "status": "active",
      "current_session": "abc123",
      "failure_count": 0,
      "specify_score": 92,
      "plan_score": 88,
      "implement_score": null,
      "pr_number": null,
      "created_at": "2026-02-26T08:00:00Z",
      "updated_at": "2026-02-26T09:30:00Z"
    }
  ],
  "total": 15,
  "hasMore": false
}
```

#### `GET /api/specflow/:featureId`

Get detailed feature state including worktree and PR info.

**Response:**
```json
{
  "feature_id": "F-027",
  "project_id": "ivy-heartbeat",
  "title": "SpecFlow State Machine Redesign",
  "description": "...",
  "phase": "implementing",
  "status": "active",
  "current_session": "abc123",
  "worktree_path": "/Users/fischer/.pai/worktrees/ivy-heartbeat/specflow-f-027",
  "branch_name": "specflow-f-027",
  "main_branch": "main",
  "failure_count": 0,
  "max_failures": 3,
  "last_error": null,
  "specify_score": 92,
  "plan_score": 88,
  "implement_score": null,
  "pr_number": null,
  "pr_url": null,
  "github_issue_number": null,
  "source": "specflow",
  "created_at": "2026-02-26T08:00:00Z",
  "updated_at": "2026-02-26T09:30:00Z",
  "phase_started_at": "2026-02-26T09:00:00Z"
}
```

#### `GET /api/specflow/:featureId/events`

Get event timeline for a feature.

**Response:**
```json
{
  "events": [
    {
      "id": 1234,
      "timestamp": "2026-02-26T09:00:00Z",
      "event_type": "specflow_phase_transition",
      "actor_id": "specflow-orchestrator",
      "target_id": "F-027",
      "summary": "Phase transition: specifying → specified",
      "metadata": {
        "fromPhase": "specifying",
        "toPhase": "specified",
        "evalScore": 92,
        "durationMs": 45000
      }
    }
  ]
}
```

### Blackboard CRUD Methods (ivy-blackboard)

```typescript
// ivy-blackboard/src/specflow-features.ts

export interface CreateFeatureInput {
  feature_id: string;
  project_id: string;
  title: string;
  description?: string;
  github_issue_number?: number;
  github_issue_url?: string;
  github_repo?: string;
  source?: string;
  source_ref?: string;
}

export interface UpdateFeatureInput {
  phase?: SpecFlowFeaturePhase;
  status?: SpecFlowFeatureStatus;
  current_session?: string | null;
  worktree_path?: string | null;
  branch_name?: string | null;
  failure_count?: number;
  last_error?: string | null;
  last_phase_error?: string | null;
  specify_score?: number | null;
  plan_score?: number | null;
  implement_score?: number | null;
  pr_number?: number | null;
  pr_url?: string | null;
  commit_sha?: string | null;
  phase_started_at?: string | null;
  completed_at?: string | null;
}

export interface ListFeaturesOptions {
  projectId?: string;
  phase?: SpecFlowFeaturePhase;
  status?: SpecFlowFeatureStatus;
  limit?: number;
}

// Methods exposed via Blackboard class
class Blackboard {
  // Existing methods...

  // New SpecFlow feature methods
  createFeature(input: CreateFeatureInput): SpecFlowFeature;
  getFeature(featureId: string): SpecFlowFeature | null;
  updateFeature(featureId: string, updates: UpdateFeatureInput): SpecFlowFeature;
  listFeatures(opts?: ListFeaturesOptions): SpecFlowFeature[];
  getActionableFeatures(maxConcurrent: number): SpecFlowFeature[];
}
```

## Phase-by-Phase Plan

### Phase 1: `specflow_features` Table in ivy-blackboard (~2h)

**Goal:** New table exists; CRUD methods accessible via Blackboard class. No changes to dispatch flow.

**Changes to `ivy-blackboard`:**
1. New migration file: `src/migrations/014-specflow-features.sql` (or next migration number)
2. New file: `src/specflow-features.ts` — TypeScript interface + CRUD functions
3. Export from `src/index.ts`: `createFeature`, `getFeature`, `updateFeature`, `listFeatures`, `getActionableFeatures`
4. Update `Blackboard` class to expose these methods
5. Tests: `tests/specflow-features.test.ts` — CRUD + state machine transitions

**Schema key decisions:**
- `phase` uses `*ing`/`*ed` convention (specifying/specified) for queryability
- `current_session` is null when not running (explicit "nothing running" signal)
- `failure_count` tracks per-feature total failures, not per-phase
- `phase_started_at` enables timeout detection without external clock

### Phase 2: Dual-Write from Existing Flow (~2h)

**Goal:** `specflow_features` is populated by the existing flow as an audit log. The old flow still controls execution.

**Changes to `ivy-heartbeat`:**
1. `src/scheduler/specflow-runner.ts` — add optional dual-write calls:
   - After entering `runSpecFlowPhase()`: write `{ phase: phaseName + 'ing', status: 'active', current_session: sessionId }`
   - After quality gate pass: write `{ phase: phaseName + 'ed', status: 'succeeded', [phase]_score: score }`
   - After failure: write `{ status: 'failed', failure_count: n, last_error: msg }`
2. `src/evaluators/github-issues.ts` — also create `specflow_features` row when creating specflow work item
3. Dual-write is wrapped in try/catch — failure logs but doesn't abort the existing flow

**Testing:** Manual verification — run one feature through the existing flow, confirm `specflow_features` row tracks lifecycle. `/api/specflow` endpoint (Phase 1 API already reads the table).

### Phase 3: Build Orchestrator (~4h)

**Goal:** New orchestrator is built and tested, running alongside old flow. Feature flag controls which is active.

**New files in `ivy-heartbeat`:**
```
src/scheduler/specflow/
  orchestrator.ts          -- Central state machine
  phases/
    specify.ts             -- specflow specify CLI + eval
    plan.ts                -- specflow plan CLI + eval
    tasks.ts               -- specflow tasks CLI
    implement.ts           -- Claude session launcher
    complete.ts            -- validate, commit, push, PR
  gates/
    quality-gate.ts        -- eval-based quality checking
    code-gate.ts           -- verify source code changes (FM-3)
  infra/
    worktree.ts            -- worktree management (extracted from specflow-runner.ts)
    specflow-cli.ts        -- CLI spawner (extracted from specflow-runner.ts)
```

**New evaluator:** `src/evaluators/specflow-orchestrate.ts`

**Key extraction from specflow-runner.ts:**
- `ensureWorktree()` → `infra/worktree.ts`
- `runSpecflowCli()` → `infra/specflow-cli.ts`
- `checkQualityGate()` → `gates/quality-gate.ts`
- Source change detection → `gates/code-gate.ts`
- Per-phase execution blocks → `phases/*.ts`

**Tests:** `tests/specflow-orchestrator.test.ts` with mock executors and mock Blackboard

### Phase 4: Switch Over (~2h)

**Goal:** Enable orchestrator via feature flag. Verify against real features.

1. Set `SPECFLOW_ORCHESTRATOR=true` in `.env`
2. Heartbeat config: add `specflow_orchestrate` evaluator entry
3. Smoke test: queue a new feature, verify it advances through all phases
4. Disable `chainNextPhase()` in specflow-runner.ts (no-op it, don't delete yet)
5. Monitor for 2-3 dispatch cycles

### Phase 5: Cleanup (~1h)

**Goal:** Remove dead code. specflow-runner.ts shrinks from 1546 to ~200 lines.

1. Remove `chainNextPhase()` and `chainRetry()` from `specflow-runner.ts`
2. Remove phase-execution blocks from `specflow-runner.ts` (now in phase executors)
3. Remove dual-write code (Phase 2 code) from `specflow-runner.ts`
4. Keep `specflow-runner.ts` as thin wrapper or rename to `legacy-runner.ts`
5. Update CHANGELOG

## Key Technical Decisions

### Decision 1: Phase Naming Convention (`specifying` vs `specified`)
Active states end in `-ing`, completed states end in `-ed`. This enables trivial queries:
- `WHERE phase LIKE '%ing'` — currently running phases
- `WHERE phase LIKE '%ed' AND status = 'pending'` — waiting to advance

### Decision 2: No Work Items for Phase Chaining
Work items are only created for: (a) initial feature registration, (b) external execution by agents that need the work item queue (review, rework, reflect). Phase-to-phase transitions happen by updating the `specflow_features` row directly.

### Decision 3: Orchestrator as Single Writer
Only the orchestrator updates `specflow_features.phase`. Phase executors return `PhaseResult`. This prevents concurrent writes and ensures the state machine remains consistent.

### Decision 4: Code Gate Logic
Filter: files changed by `git diff --stat HEAD` excluding `.specify/`, `CHANGELOG.md`, `Plans/`, `docs/`, `README.md`, `.claude/`, `verify.md`.
If zero unfiltered files → gate fails. This is the direct fix for FM-3.

### Decision 5: Feature Flag First
`SPECFLOW_ORCHESTRATOR=true/false` in `.env`. Default: `false` during Phases 1-3. Switch to `true` in Phase 4. This allows instant rollback without code changes.

### Decision 6: Backward Compatibility Window
Phase 2 dual-write runs for at least 2 full dispatch cycles before Phase 4 switchover. This ensures the `specflow_features` table has data for all in-flight features before the orchestrator takes control.

## File Edit Manifest

### ivy-blackboard changes
| File | Change type | What changes |
|------|-------------|-------------|
| `src/migrations/014-specflow-features.sql` | create | New table DDL |
| `src/specflow-features.ts` | create | TypeScript types + CRUD |
| `src/index.ts` | edit | Export new CRUD methods |
| `src/blackboard.ts` | edit | Add feature methods to Blackboard class |
| `tests/specflow-features.test.ts` | create | Unit tests for CRUD + state |

### ivy-heartbeat changes
| File | Change type | What changes |
|------|-------------|-------------|
| `src/scheduler/specflow-runner.ts` | edit | Add dual-write calls (Phase 2), strip to thin wrapper (Phase 5) |
| `src/evaluators/github-issues.ts` | edit | Create specflow_features row alongside work item |
| `src/scheduler/specflow/orchestrator.ts` | create | Central state machine |
| `src/scheduler/specflow/phases/specify.ts` | create | Specify phase executor |
| `src/scheduler/specflow/phases/plan.ts` | create | Plan phase executor |
| `src/scheduler/specflow/phases/tasks.ts` | create | Tasks phase executor |
| `src/scheduler/specflow/phases/implement.ts` | create | Implement phase executor |
| `src/scheduler/specflow/phases/complete.ts` | create | Complete phase executor |
| `src/scheduler/specflow/gates/quality-gate.ts` | create | Eval-based gate |
| `src/scheduler/specflow/gates/code-gate.ts` | create | Source change detection gate |
| `src/scheduler/specflow/infra/worktree.ts` | create | Extracted worktree management |
| `src/scheduler/specflow/infra/specflow-cli.ts` | create | Extracted CLI spawner |
| `src/evaluators/specflow-orchestrate.ts` | create | New evaluator type |
| `src/server.ts` | edit | Add /api/specflow endpoints |
| `tests/specflow-orchestrator.test.ts` | create | Orchestrator unit tests |

## Testing Strategy

### Unit Tests
- `tests/specflow-features.test.ts` — CRUD operations, phase transitions, actionable feature queries
- `tests/specflow-orchestrator.test.ts` — `determineAction()`, mock executors, state transitions
- `tests/code-gate.test.ts` — detection of source changes, filtering excluded paths

### Integration Tests
- Phase 2: Manual verification that dual-write populates `specflow_features` during existing dispatch cycle
- Phase 4: End-to-end feature lifecycle via orchestrator (queue → completed)

### Regression Tests
- Existing 490 tests must continue to pass after each phase
- Key: `bun test` after Phase 2 dual-write addition and after Phase 3 orchestrator addition

## Risk Mitigations

| Risk | Mitigation |
|------|------------|
| Orchestrator bug blocks all features | Phase 2 dual-write means old flow is functional as fallback (flip feature flag) |
| SQLite contention | One writer (orchestrator) + readers. WAL mode handles this. |
| Agent dies mid-phase | `phase_started_at` + timeout = automatic recovery on next heartbeat |
| In-flight features during migration | Phase 2 populates table for in-flight features before Phase 4 takeover |
| Code gate too aggressive | Gate uses explicit file path exclusions; can be tuned without code change |

## Effort Estimate

| Phase | Effort | Repo |
|-------|--------|------|
| 1: specflow_features table | ~2h | ivy-blackboard |
| 2: Dual-write | ~2h | ivy-heartbeat |
| 3: Orchestrator build | ~4h | ivy-heartbeat |
| 4: Switchover | ~2h | ivy-heartbeat |
| 5: Cleanup | ~1h | ivy-heartbeat |
| **Total** | **~11h** | — |

## Dependencies

### External Packages

No new external packages required. Uses existing:
- `bun:sqlite` — Database access (ivy-blackboard)
- `zod` — Runtime validation (ivy-blackboard, already used)
- `commander` — CLI (specflow, already used)

### Internal Dependencies

```
ivy-heartbeat
  └── ivy-blackboard (npm: ivy-blackboard)
        └── specflow-features.ts (NEW)
```

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SPECFLOW_ORCHESTRATOR` | `false` | Enable new orchestrator (Phase 4 toggle) |
| `SPECFLOW_BIN` | `~/bin/specflow` | Path to specflow CLI |
| `IVY_WORKTREE_DIR` | `~/.pai/worktrees` | Worktree base directory |

## File Structure

### ivy-blackboard (changes)

```
ivy-blackboard/
├── src/
│   ├── schema.ts                 # MODIFY: Add V6 migration
│   ├── specflow-features.ts      # NEW: CRUD operations
│   ├── index.ts                  # MODIFY: Export new module
│   └── types.ts                  # MODIFY: Add SpecFlowFeature type
└── tests/
    └── specflow-features.test.ts # NEW: Unit tests
```

### ivy-heartbeat (changes)

```
ivy-heartbeat/
└── src/
    ├── evaluators/
    │   ├── specflow-orchestrate.ts    # NEW: Orchestrator evaluator
    │   └── github-issues.ts           # MODIFY: Add feature creation
    ├── scheduler/
    │   ├── specflow-runner.ts         # MODIFY: Slim down, delegate to executors
    │   ├── specflow-types.ts          # MODIFY: Update phase types
    │   └── specflow/                  # NEW: Directory
    │       ├── types.ts               # NEW: PhaseExecutor interface
    │       ├── orchestrator.ts        # NEW: Main orchestration logic
    │       ├── orchestrator-types.ts  # NEW: Orchestrator types
    │       ├── executor-registry.ts   # NEW: Phase → executor mapping
    │       ├── phases/                # NEW: Directory
    │       │   ├── specify.ts         # NEW: Specify phase executor
    │       │   ├── plan.ts            # NEW: Plan phase executor
    │       │   ├── tasks.ts           # NEW: Tasks phase executor
    │       │   ├── implement.ts       # NEW: Implement phase executor
    │       │   └── complete.ts        # NEW: Complete phase executor
    │       └── gates/                 # NEW: Directory
    │           ├── code-gate.ts       # NEW: Source code change gate
    │           ├── eval-gate.ts       # NEW: Quality score gate
    │           └── artifact-gate.ts   # NEW: File existence gate
    └── serve/
        ├── server.ts                  # MODIFY: Add /api/specflow routes
        └── api/
            └── specflow-features.ts   # NEW: API handlers

tests/
├── specflow-features.test.ts          # NEW: CRUD unit tests
├── specflow-orchestrator.test.ts      # NEW: Orchestrator unit tests
├── code-gate.test.ts                  # NEW: Code gate unit tests
└── specflow-phases/*.test.ts          # NEW: Per-phase executor tests
```

## Success Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| `specflow-runner.ts` lines | 1545 | < 300 | `wc -l` |
| Stuck features (24h) | Variable | 0 | Query `specflow_features` for stale sessions |
| Docs-only PRs | Occasional | 0 | Code gate blocks advancement |
| Phase visibility | Distributed work items | Single API | `/api/specflow` returns all features |
| Phase executor size | N/A | < 200 lines each | `wc -l` per file |

---

## Appendix A: Schema Migration SQL

```sql
-- V6: Add specflow_features table
CREATE TABLE specflow_features (
  feature_id       TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL,
  title            TEXT NOT NULL,
  description      TEXT,
  phase            TEXT NOT NULL DEFAULT 'queued'
                   CHECK (phase IN ('queued', 'specifying', 'specified',
                          'planning', 'planned', 'tasking', 'tasked',
                          'implementing', 'implemented', 'completing',
                          'completed', 'failed', 'blocked')),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'active', 'succeeded',
                          'failed', 'blocked')),
  current_session  TEXT,
  worktree_path    TEXT,
  branch_name      TEXT,
  main_branch      TEXT DEFAULT 'main',
  failure_count    INTEGER NOT NULL DEFAULT 0,
  max_failures     INTEGER NOT NULL DEFAULT 3,
  last_error       TEXT,
  last_phase_error TEXT,
  specify_score    INTEGER,
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
  completed_at     TEXT,

  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (current_session) REFERENCES agents(session_id)
);

CREATE INDEX idx_specflow_features_project ON specflow_features(project_id);
CREATE INDEX idx_specflow_features_phase ON specflow_features(phase);
CREATE INDEX idx_specflow_features_status ON specflow_features(status);
CREATE INDEX idx_specflow_features_session ON specflow_features(current_session);
```

## Appendix B: Orchestrator State Machine Logic

```typescript
// Pseudocode for determineAction()

function determineAction(feature: SpecFlowFeature): OrchestratorAction {
  // Terminal states — no action
  if (feature.phase === 'completed' || feature.phase === 'failed') {
    return { type: 'wait', reason: 'terminal state' };
  }

  // Blocked — needs human intervention
  if (feature.status === 'blocked') {
    return { type: 'wait', reason: 'blocked' };
  }

  // Max failures reached
  if (feature.failure_count >= feature.max_failures) {
    return { type: 'fail', reason: 'max failures exceeded' };
  }

  // Active session — check if stale
  if (feature.current_session && feature.status === 'active') {
    if (isStale(feature.phase_started_at, PHASE_TIMEOUT_MIN)) {
      return { type: 'release', reason: 'session timeout' };
    }
    return { type: 'wait', reason: 'session active' };
  }

  // Phase ends with 'ing' (active phase) but status is succeeded
  // → time to check gate
  if (feature.phase.endsWith('ing') && feature.status === 'succeeded') {
    return { type: 'check-gate', gate: getGateForPhase(feature.phase) };
  }

  // Phase ends with 'ed' (completed phase) — advance to next
  if (feature.phase.endsWith('ed') && feature.status === 'pending') {
    const next = getNextPhase(feature.phase);
    if (next) {
      return { type: 'advance', fromPhase: feature.phase, toPhase: next };
    }
  }

  // Pending status — ready to run
  if (feature.status === 'pending') {
    return { type: 'run-phase', phase: feature.phase };
  }

  return { type: 'wait', reason: 'no action available' };
}
```

## Appendix C: Code Gate Exclusion List

Files excluded from source code change detection:

```typescript
const CODE_GATE_EXCLUSIONS = [
  '.specify/',
  'CHANGELOG.md',
  'Plans/',
  'docs/',
  'README.md',
  '.claude/',
  'verify.md',
  '.specflow/',
];
```

Note: Test files are NOT excluded — implementing tests is valid implementation work.
