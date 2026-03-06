# F-030: Agent Memory Repository

## Overview

Evaluators run with no cross-session context. The calendar evaluator doesn't know when it last fired an alert. The review evaluator doesn't remember that PR #48 needed 3 cycles. Each session starts blind, causing duplicate alerts and missed patterns. This feature adds a persistent `agent_memory` table to `ivy-blackboard` with FTS5 search, implementing both alert deduplication and cross-session memory in one primitive.

**Repos affected:** `ivy-blackboard` (new table + API), `ivy-heartbeat` (evaluators use `bb.remember/recall/forget`)

**Sprint:** 1 (Week 1) | Priority: 3 (High) | Effort: M (2-3 days) | Grade: B+

## Problem Statement

Every evaluator invocation is amnesiac:

- Calendar evaluator fires the same "conflict between meetings A and B" alert every cycle
- Review evaluator doesn't know it already requested changes on PR #48 twice
- No cross-evaluator shared context (calendar in-meeting status not readable by scheduler)
- No TTL on stale memories (old context accumulates)

Steve Yegge's beads project (v0.58.0) independently arrived at `bd remember / bd recall / bd forget` to solve this exact gap. This feature implements equivalent primitives natively in ivy-blackboard.

### Failure Mode Catalog

| ID | Symptom | Root Cause |
|----|---------|-----------|
| FM-1 | Duplicate calendar conflict alerts | No memory of last alert for this conflict |
| FM-2 | Review evaluator repeats same feedback | No memory of previous review cycles |
| FM-3 | Scheduler can't gate on calendar state | Calendar state not persisted anywhere machine-readable |
| FM-4 | Memory grows unbounded | No TTL support |

## Users & Stakeholders

- **Primary user:** PAI operator (Jens-Christian) — wants alert deduplication within a reasonable window (2h)
- **Pipeline maintainer:** Jens-Christian — wants evaluators to build on prior context

## User Scenarios

### Scenario 1: Calendar Conflict Deduplication

**Given:** Calendar evaluator detected conflict between "Team Sync" and "1:1 with Alex" at 14:00
**When:** It fires an alert and stores `bb.remember('calendar', 'conflict-team-sync-1:1-alex-14:00', '...')`
**And:** On the next cycle (15 min later), the conflict still exists
**When:** The evaluator runs `bb.recall('calendar', 'conflict team sync 1:1')`
**Then:** It finds a memory updated < 2h ago
**And:** Skips firing the duplicate alert

### Scenario 2: Calendar State for Scheduler Gating (F-032 dependency)

**Given:** Calendar evaluator detects the user is in a meeting until 15:30
**When:** It stores `bb.remember('calendar', 'current-status', 'in-meeting until 15:30', { ttl: '2h' })`
**Then:** F-032 calendar-gated scheduling can call `bb.recall('calendar', 'current-status')` and read the in-meeting state

### Scenario 3: Cross-Session PR Review Context

**Given:** PR #48 received "changes_requested" in session 1
**When:** Session 2 starts and the review evaluator runs for PR #48
**Then:** `bb.recall('github-pr-review', 'pr-48 review history')` returns the prior cycle result
**And:** The evaluator notes "this PR has been reviewed twice already" in its context

### Scenario 4: Memory Expiry

**Given:** A calendar "in-meeting" memory was stored 3h ago with TTL=2h
**When:** Any evaluator calls `bb.recall('calendar', 'current-status')`
**Then:** The expired memory is not returned
**And:** The memory is automatically cleaned up (lazy expiry on read, or scheduled weekly job)

## Acceptance Criteria

1. `agent_memory` table created with: `id, evaluator, key, value, created_at, updated_at, expires_at`
2. FTS5 virtual table `agent_memory_fts` indexes `key` and `value`
3. `bb.remember(evaluator, key, value, options?: { ttl?: string }): void` — upserts by (evaluator, key)
4. `bb.recall(evaluator, query): AgentMemory[]` — FTS search within evaluator's namespace
5. `bb.forget(evaluator, key): void` — deletes by (evaluator, key)
6. Expired memories (where `expires_at < now()`) not returned by `recall`
7. Calendar evaluator updated: check recall before alerting, store after alerting
8. Dashboard shows agent memory count per evaluator
9. Existing 490 tests pass; new tests cover remember/recall/forget/expiry

## Technical Design

### Schema (ivy-blackboard)

```sql
CREATE TABLE agent_memory (
  id TEXT PRIMARY KEY,
  evaluator TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  UNIQUE(evaluator, key)
);
CREATE VIRTUAL TABLE agent_memory_fts USING fts5(key, value, content=agent_memory, content_rowid=rowid);
```

### API (ivy-blackboard)

```typescript
bb.remember(evaluator: string, key: string, value: string, opts?: { ttl?: string }): void
  // UPSERT with expires_at = now() + ttl if provided

bb.recall(evaluator: string, query: string): AgentMemory[]
  // FTS5 search within evaluator namespace, excludes expired

bb.forget(evaluator: string, key?: string): void
  // DELETE by evaluator or (evaluator, key)
```

### Calendar Evaluator Integration (ivy-heartbeat)

```typescript
// Before firing alert:
const recent = await bb.recall('calendar', `conflict ${eventId}`);
if (recent.length && recent[0].updatedAt > twoHoursAgo) return; // suppress duplicate

// After firing alert:
await bb.remember('calendar', `conflict ${eventId}`,
  `Conflict between "${a.title}" and "${b.title}" alerted at ${now}`, { ttl: '4h' });
```

## Out of Scope

- Semantic/vector search over memories (FTS5 sufficient for keyword recall)
- Memory sharing between different projects (scoped to evaluator namespace)
- UI for browsing/editing memories (dashboard count only for now)
