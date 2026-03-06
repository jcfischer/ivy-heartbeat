# F-032: Calendar-Gated Scheduling

## Overview

Heavy evaluators (specflow-orchestrate, PR review, implement) fire on their cron schedule regardless of what the user is doing. During meetings, these create noise and waste API budget. This feature adds a scheduler gate that checks the calendar evaluator's persisted in-meeting state (stored via F-030 agent memory) before dispatching heavy evaluators.

**Repos affected:** `ivy-heartbeat` (scheduler.ts gate function)

**Dependency:** F-030 (Agent Memory Repository) must be implemented first

**Sprint:** 1 (Week 1, after F-030) | Priority: 5 (Medium) | Effort: S (0.5 days) | Grade: B-

## Problem Statement

The scheduler dispatches heavy evaluators (specflow-orchestrate, PR review) on every heartbeat cycle, even when Jens-Christian is in a meeting. This:

- Creates distraction (notifications, GitHub activity during meetings)
- Wastes API budget on operations that won't get human attention anyway
- Could trigger PR merges or code reviews that need immediate follow-up

The calendar evaluator already knows the meeting status — it just doesn't persist it anywhere machine-readable.

## Users & Stakeholders

- **Primary user:** PAI operator (Jens-Christian) — wants zero heavy evaluator noise during meetings

## User Scenarios

### Scenario 1: Heavy Evaluators Suppressed During Meeting

**Given:** Calendar evaluator stored `bb.remember('calendar', 'current-status', 'in-meeting until 15:30', { ttl: '2h' })`
**When:** The scheduler's heartbeat cycle fires
**And:** `shouldRunHeavyEvaluators()` is called
**Then:** It calls `bb.recall('calendar', 'current-status')` and finds `value = 'in-meeting until 15:30'`
**And:** Returns `false`
**And:** specflow-orchestrate, PR-review, and implement evaluators are skipped this cycle
**And:** Light evaluators (calendar check itself, cost guard) still run

### Scenario 2: Heavy Evaluators Run When Not in Meeting

**Given:** No `current-status` memory, or memory value = 'free'
**When:** `shouldRunHeavyEvaluators()` is called
**Then:** Returns `true`
**And:** All evaluators dispatch normally

### Scenario 3: Stale Meeting Memory Expires

**Given:** A `current-status = in-meeting` memory was stored 3h ago with TTL=2h
**When:** `shouldRunHeavyEvaluators()` is called
**Then:** The expired memory is not returned by `bb.recall`
**And:** Returns `true` (safe default — run evaluators when uncertain)

### Scenario 4: Calendar Evaluator Stores Status After Each Check

**Given:** Calendar evaluator runs and finds no conflicts, user is free
**When:** It completes its check
**Then:** It stores `bb.remember('calendar', 'current-status', 'free', { ttl: '1h' })`
**And:** On the next cycle, `shouldRunHeavyEvaluators()` returns `true`

## Acceptance Criteria

1. Calendar evaluator stores `current-status` memory after every check (values: `'free'` or `'in-meeting until HH:MM'`)
2. `shouldRunHeavyEvaluators(): Promise<boolean>` function added to `scheduler.ts`
3. Gate is called before dispatching: specflow-orchestrate, pr-review, implement evaluators
4. Light evaluators (calendar, cost-guard, gh-issues scan) bypass the gate
5. Default is `true` (run) when memory is absent or expired — fail open
6. Existing 490 tests pass; new test covers in-meeting suppression and expiry behavior

## Technical Design

### Gate Function (ivy-heartbeat scheduler.ts)

```typescript
async function shouldRunHeavyEvaluators(): Promise<boolean> {
  try {
    const calState = await bb.recall('calendar', 'current-status');
    if (!calState.length) return true; // no memory = safe to run
    const latest = calState[0];
    return !latest.value.startsWith('in-meeting');
  } catch {
    return true; // fail open
  }
}
```

### Calendar Evaluator Update (ivy-heartbeat)

```typescript
// After completing calendar check:
const status = hasActiveConflicts
  ? `in-meeting until ${formatTime(nextFreeSlot)}`
  : 'free';
await bb.remember('calendar', 'current-status', status, { ttl: '1h' });
```

### Heavy vs Light Evaluator Classification

| Evaluator | Classification | Reasoning |
|-----------|---------------|-----------|
| specflow-orchestrate | Heavy | Triggers implement agents, long-running |
| pr-review | Heavy | Calls Claude API, posts to GitHub |
| implement | Heavy | Long-running agent sessions |
| calendar | Light | Just reads local calendar, needed for the gate itself |
| cost-guard | Light | Just reads API cost metrics |
| gh-issues-scan | Light | Read-only GitHub query |

## Out of Scope

- Time-based scheduling (e.g., "no heavy evaluators before 9am")
- Manual override command to force heavy evaluators during meeting
- Integration with Tado or other sensors for "at desk" detection
