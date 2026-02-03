# F-008: Heartbeat Cost Guard

## Overview

Hash-based change detection for the heartbeat checklist. Before running evaluators, the check command computes a hash of the parsed checklist + current due items. If neither has changed since the last successful run and no items are due, the entire evaluation is skipped. This prevents unnecessary work when the heartbeat runs on a fixed schedule (e.g., every hour via launchd) but nothing has changed.

## User Scenarios

### S-1: Checklist Unchanged, Nothing Due
**Given** `ivy-heartbeat check` ran 20 minutes ago and nothing is due for another 40 minutes
**When** launchd triggers `ivy-heartbeat check` again
**Then** the command detects no items are due, logs a `heartbeat_skipped` event, and exits in <100ms

### S-2: Checklist Modified Since Last Run
**Given** the user edited `IVY_HEARTBEAT.md` to add a new check item
**When** `ivy-heartbeat check` runs
**Then** the hash mismatch is detected and all due items are evaluated normally

### S-3: Items Become Due Between Runs
**Given** a check was last run 65 minutes ago with a 60-minute interval
**When** `ivy-heartbeat check` runs
**Then** the due-check detects the item is due and evaluation proceeds despite no checklist change

### S-4: Skip Event Recorded
**Given** a skip occurs because nothing changed
**When** the skip completes
**Then** a `heartbeat_skipped` event is recorded with the checklist hash and reason

### S-5: Force Flag Bypasses Guard
**Given** nothing has changed since last run
**When** `ivy-heartbeat check --force` runs
**Then** all enabled items are evaluated regardless of the cost guard

## Functional Requirements

### FR-1: Checklist Hash Computation
Compute a SHA-256 hash of:
1. The raw content of the checklist file
2. This hash is stored alongside the last successful run

```typescript
interface CostGuardState {
  checklistHash: string;     // SHA-256 of file content
  timestamp: string;         // ISO of last successful run
  dueCount: number;          // How many items were due
}
```

### FR-2: Guard Logic in Runner
Insert the cost guard before the evaluation loop in `runChecks()`:

1. Compute current checklist hash
2. Check how many items are due
3. If zero items are due, skip evaluation entirely
4. Record skip event

The guard is purely an optimization of the existing due-check flow. If no items are due (all recently checked), skip the evaluation loop. No separate hash storage needed — the existing due-check already handles this.

### FR-3: Skip Event Recording
When evaluation is skipped:
```typescript
bb.appendEvent({
  actorId: sessionId,
  summary: 'Heartbeat skipped: no items due',
  metadata: {
    checklistHash: hash,
    enabledCount: enabled.length,
    reason: 'no_items_due',
  },
});
```

### FR-4: Force Flag
Add `--force` to the check command:
```
ivy-heartbeat check --force
```
When set, skip the cost guard and evaluate all due items even if the guard would skip.

### FR-5: Output on Skip
When skipped, print a concise message:
```
ivy-heartbeat check — skipped (no items due, 3 enabled)
```

With `--json`:
```json
{
  "ok": true,
  "skipped": true,
  "reason": "no_items_due",
  "enabledCount": 3,
  "checklistHash": "abc123..."
}
```

## Architecture

```
src/check/runner.ts      — Add cost guard logic before evaluation loop
src/check/guard.ts       — Hash computation and guard state (NEW)
src/commands/check.ts    — Add --force flag
src/check/types.ts       — Add CostGuardResult to CheckSummary
```

## Dependencies
- F-007 (Heartbeat check command) — complete

## Success Criteria

1. When no items are due, evaluation loop is skipped
2. A `heartbeat_skipped` event is recorded on skip
3. `--force` bypasses the guard
4. Checklist file hash is computed and included in skip events
5. Skip produces correct terminal and JSON output
6. Existing tests for due items still pass unchanged
7. Guard adds <10ms overhead to normal runs
