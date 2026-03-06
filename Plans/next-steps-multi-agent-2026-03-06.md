# ivy-heartbeat: Next Steps Proposal
**Date:** 2026-03-06
**Based on:** ragent RAG analysis (32k articles, confidence 0.85), beads investigation, session findings

---

## Context

This proposal synthesizes three evidence sources:

1. **ragent ask/search** — 20 articles on multi-agent workflow failures, orchestration, and memory patterns (confidence 0.85). Key source: [GitHub Engineering Blog — "Multi-agent workflows often fail. Here's how to engineer ones that don't."](https://app.getsift.ch/articles/29095)
2. **Steve Yegge's beads project** — Independent validation of ivy-heartbeat's blackboard architecture, plus 3 concrete capability gaps revealed by comparison
3. **Current ivy-heartbeat state** — F-027 state machine redesign in progress (Phase 2 dual-write complete), 490 tests, full specflow pipeline operational

---

## What the Research Confirms

> *"Most multi-agent workflow failures stem from missing structure rather than model capability limitations."*
> — GitHub Engineering Blog [29095], confidence 0.85

This is the single most important finding. The ivy-heartbeat pipeline's recurring bugs (#39, #40, #41, #42, #44) all trace to **structural gaps**, not model quality:
- #41 merge-fix loop → no failure state taxonomy
- #40 blocking issues lost → no cross-cycle state persistence
- #39 source filter bug → no typed phase output contracts
- #42 transient failures → no dead letter quarantine

Beads (Steve Yegge, 18K stars, built independently) arrived at the same primitives as ivy-blackboard — work items, claim, block, event trail — validating the architecture. The gaps beads reveals are the **same gaps** the ragent analysis identifies.

---

## Proposed Features (Priority-Ordered)

---

### F-028 — Dead Letter Queue + Typed Failure States
**Priority: 1 (Critical) | Effort: S (1-2 days) | Grade: A**

**Problem:** Work items that fail repeatedly re-enter the queue indefinitely. The merge-fix loop (#41) is the canonical example. There is no `failed` state, no failure count, no quarantine.

**Evidence:**
- ragent [29095]: *"graceful degradation when individual agents fail"*
- ragent [31304]: *"updated methods for scaling that focus on probabilistic reasoning about agent capabilities"*
- Beads comparison: both beads and ivy-blackboard lack this — it's a gap in the entire category

**What to build in `ivy-blackboard`:**

```typescript
// New fields on work_items table
failure_count: integer DEFAULT 0
failure_reason: text
failed_at: datetime
status: 'pending' | 'running' | 'completed' | 'failed' | 'quarantined'

// New functions
failWorkItem(itemId, reason): void         // increment failure_count, set failed_at
quarantineWorkItem(itemId, reason): void   // status=quarantined, never re-dispatched
getFailedItems(): WorkItem[]               // dashboard query
```

**Policy:** After 3 failures → quarantine. Surface in dashboard with failure_reason. Add `ivy-heartbeat retry <item-id>` to manually requeue.

**Acceptance:** The merge-fix loop scenario (transient `gh pr merge` failure) → item fails once, retries twice, if still failing → quarantined with `"gh pr merge failed 3 times"`. Never loops again.

---

### F-029 — Typed WorkItem Metadata + Structured Handoffs
**Priority: 2 (High) | Effort: M (3-4 days) | Grade: A**

**Problem:** Work item `meta` is an untyped JSON blob. Each evaluator interprets it differently. No compile-time guarantees that a downstream evaluator receives the fields it expects. This is the structural gap that caused #39 (source filter), #40 (blocking issues), and #44 (cross-cycle data loss).

**Evidence:**
- ragent [29095]: *"clear role definitions, well-defined interfaces between agents"*
- ragent [94008/94023]: *"hierarchical task decomposition — bounded autonomy to prevent agents from exceeding their intended scope"*
- Beads: `discovered-from` relationship type enforces typed provenance between parent and child issues

**What to build:**

```typescript
// Typed meta variants — one per work item operation
type SpecFlowMeta = {
  featureId: string;
  phase: SpecFlowPhase;
  specPath: string;
  worktreePath?: string;
}

type PRReviewMeta = {
  prNumber: number;
  prUrl: string;
  repoOwner: string;
  repoName: string;
  headBranch: string;
  blockingIssues: BlockingIssue[];  // persisted from #44 fix
}

type MergeMeta = {
  prNumber: number;
  prUrl: string;
  mergeStrategy: 'squash' | 'merge' | 'rebase';
  retryCount: number;
}

type WorkItemMeta = SpecFlowMeta | PRReviewMeta | MergeMeta | CalendarMeta | ...

// Runtime validation at work item creation
function createWorkItem(opts: CreateWorkItemOptions): CreateWorkItemResult {
  validateMeta(opts.operation, opts.meta); // throws if schema mismatch
  ...
}
```

**Also add `parent_event_id`** to work items and events — enables causal chain tracing in the dashboard (which check → which alert → which work item → which outcome).

---

### F-030 — Agent Memory Repository
**Priority: 3 (High) | Effort: M (2-3 days) | Grade: B+**

**Problem:** Evaluators run with no cross-session context. The calendar evaluator doesn't know the last time it fired this alert. The review evaluator doesn't remember that PR #48 needed 3 cycles. Each session starts blind.

**Evidence:**
- ragent [18225 AMA]: *"existing approaches rely on rigid retrieval granularity, accumulation-heavy maintenance strategies"*
- ragent [Confucius Code Agent]: *"coding agents must maintain durable memory across and within long sessions"*
- Beads v0.58.0: independently added `bd remember / bd recall / bd forget` commands to address exactly this gap

**What to build in `ivy-blackboard`:**

```typescript
// New agent_memory table
CREATE TABLE agent_memory (
  id TEXT PRIMARY KEY,
  evaluator TEXT NOT NULL,         -- 'calendar', 'github-pr-review', etc.
  key TEXT NOT NULL,               -- searchable identifier
  value TEXT NOT NULL,             -- free-form content
  embedding TEXT,                  -- optional FTS5 index
  created_at DATETIME,
  updated_at DATETIME,
  expires_at DATETIME              -- optional TTL
);
CREATE VIRTUAL TABLE agent_memory_fts USING fts5(key, value);

// API
bb.remember(evaluator, key, value, ttl?): void
bb.recall(evaluator, query): AgentMemory[]   // FTS search
bb.forget(evaluator, key): void
```

**Usage pattern:**

```typescript
// In calendar evaluator — BEFORE checking
const recent = bb.recall('calendar', `conflict ${eventId}`);
if (recent.length && recent[0].updatedAt > 2h ago) {
  return; // suppress duplicate alert
}

// AFTER firing alert
bb.remember('calendar', `conflict ${eventId}`,
  `Conflict between "${a.title}" and "${b.title}" alerted at ${now}`);
```

This implements both **alert deduplication** (#3 from ranked list) and **cross-session memory** in one table.

---

### F-031 — Dependency-Aware Dispatch
**Priority: 4 (Medium) | Effort: M (2-3 days) | Grade: B+**

**Problem:** The dispatch worker grabs the oldest unclaimed work item regardless of dependencies. A PR merge item can be dispatched before its review is approved. A specflow implement item can run before its plan is complete.

**Evidence:**
- ragent [29095]: *"explicit dependency management for task sequencing"*
- Beads: `bd ready --json` is the flagship feature — only returns items with all blockers resolved, traversing the full dependency graph

**What to build:**

Add `depends_on` field to work items (array of item IDs). Extend `listWorkItems` to filter out items where any `depends_on` target is not `completed`. Dispatch worker uses the filtered list.

```typescript
// Creating with dependency
bb.createWorkItem({
  operation: 'pr-merge',
  meta: { prNumber: 48 },
  dependsOn: ['review-work-item-id'],  // NEW: won't dispatch until review completes
});

// Dispatch worker query (updated)
bb.listReadyWorkItems()  // NEW: excludes items with pending dependencies
```

Also enables: specflow phase chain expressed as dependencies (`plan dependsOn specify`, `implement dependsOn plan`) rather than the current implicit phase sequencing through evaluator logic.

---

### F-032 — Calendar-Gated Scheduling
**Priority: 5 (Medium) | Effort: S (0.5 days) | Grade: B-**

**Problem:** Heavy evaluators (specflow-orchestrate, PR review, implement) fire on their cron schedule regardless of what the user is doing. During meetings, these create noise and waste API budget.

**Evidence:**
- ragent [29102]: *"Continuous AI — agents as background processes that adapt to context"*
- ragent [18552 PAI]: *"schedule around user context"*

**What to build:**

In `scheduler.ts`, before dispatching heavy evaluators, check the calendar evaluator's last result:

```typescript
async function shouldRunHeavyEvaluators(): Promise<boolean> {
  const calState = bb.recall('calendar', 'current-status');
  if (calState?.value === 'in-meeting') return false;
  return true;
}
```

The calendar evaluator already has this data — just need to persist it to agent memory (F-030) and read it in the scheduler gate.

---

### F-033 — Evaluator / Scheduler Boundary Cleanup
**Priority: 6 (Architecture) | Effort: L (1 week) | Grade: C+**

**Problem:** The scheduler both decides WHAT to run and directly calls some evaluators. The dispatch worker handles others. The boundary is inconsistent — some evaluators are invoked synchronously in `scheduler.ts`, others via work items.

**Evidence:**
- ragent [31304]: *"separation of workflow logic from error handling and search mechanisms"* (Probabilistic Angelic Nondeterminism pattern)
- ragent [29095]: *"workflow orchestration, error recovery, and search — each optimized independently"*
- Beads architecture: pure separation — beads only tracks state, agents only execute, never mixed

**Target architecture:**

```
Scheduler → writes WorkItems only → never calls evaluators directly
Dispatch Worker → reads WorkItems → calls evaluators → writes results back
Evaluators → pure logic, no DB writes except via bb API
```

**Dependency:** Requires F-028 (failure states) and F-029 (typed meta) first. This is the refactor that makes them all coherent.

---

### F-034 — GitHub Webhook Ingestion
**Priority: 7 (Backlog) | Effort: L | Grade: C**

**Problem:** PR status (review approved, review requested changes, merge complete) is polled every 15 minutes even when nothing changes. This adds latency and wastes rate limit quota.

**What to build:** A webhook receiver endpoint that GitHub calls on PR events → writes directly to the blackboard event log → wakes the evaluator. The scheduler becomes wake-on-event for GitHub evaluators rather than polling.

**Dependency:** Requires a stable public endpoint (ngrok for local dev, server for prod). Lower priority because the current 15-min polling is acceptable.

---

## Sequencing

```
NOW IN PROGRESS
└── F-027 SpecFlow State Machine (Phase 3: orchestrator)

SPRINT 1 (Week 1) — Quick structural wins
├── F-028 Dead Letter Queue + Typed Failure States
├── F-030 Agent Memory Repository (table + FTS)
└── F-032 Calendar-Gated Scheduling (depends on F-030)

SPRINT 2 (Week 2) — Interface contracts
├── F-029 Typed WorkItem Metadata + parent_event_id
└── F-031 Dependency-Aware Dispatch

SPRINT 3 (Week 3+) — Architecture
└── F-033 Evaluator/Scheduler Boundary Cleanup

BACKLOG
└── F-034 GitHub Webhook Ingestion
```

---

## What Beads Confirms (and What It Doesn't Replace)

Beads is a parallel independent effort that validates ivy-heartbeat's architecture:

| Beads feature | ivy-heartbeat equivalent | Gap? |
|--------------|--------------------------|------|
| `bd update --claim` | `claimWorkItem()` | ✅ Same |
| `bd dep add` | `blockWorkItem()` | ⚠️ Less rich — no types |
| `bd ready --json` | `listWorkItems({status:'pending'})` | ❌ No dependency traversal |
| `bd remember/recall` | MEMORY.md files | ❌ Not machine-queryable |
| `discovered-from` | — | ❌ No parent_event_id |
| Dolt distributed sync | SQLite single-machine | ✅ Sufficient for current scale |
| Hash-based collision-free IDs | Sequential item IDs | ✅ Single machine, no collision risk |

**Decision: Don't adopt beads. Build F-030 (memory) and F-031 (dependency dispatch) natively in ivy-blackboard.**

The stack mismatch (Go vs TypeScript/Bun), Dolt server requirement, and deep ivy-blackboard integration make migration unjustified. The patterns are worth implementing directly.

---

## Success Metrics

| Feature | Metric | Target |
|---------|--------|--------|
| F-028 | No work item exceeds 3 dispatch attempts without quarantine | 100% |
| F-029 | TypeScript compile catches meta schema mismatches | All evaluators typed |
| F-030 | Duplicate alert suppression within 2h window | Calendar, GH-issues, PR-review |
| F-031 | PR merge never dispatched before review completed | 100% |
| F-032 | Zero heavy evaluator runs during calendar "in-meeting" | 100% |

---

## Risks

| Risk | Mitigation |
|------|-----------|
| F-027 Phase 3 (orchestrator) creates regressions | Feature flag `SPECFLOW_ORCHESTRATOR` allows rollback |
| Typed meta migration breaks existing work items | Additive schema change — old items get default meta type |
| Agent memory table grows unbounded | TTL field + scheduled cleanup job (weekly) |
| Dependency cycles (A depends on B depends on A) | Cycle detection at `createWorkItem` time |
