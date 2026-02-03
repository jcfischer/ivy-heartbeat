# F-007: Heartbeat Check Command

## Overview

The core runtime command for ivy-heartbeat: `ivy-heartbeat check`. Registers as an agent, parses the checklist from `~/.pai/IVY_HEARTBEAT.md`, determines which items are due, evaluates them, records results to the blackboard, and deregisters. Designed to run as a one-shot command (suitable for launchd/cron) or interactively.

## User Scenarios

### S-1: Run All Due Checks
**Given** `~/.pai/IVY_HEARTBEAT.md` has 3 enabled items and none have been checked recently
**When** the user runs `ivy-heartbeat check`
**Then** all 3 items are evaluated, results are recorded as heartbeats and events, and a summary is printed

### S-2: Skip Recently Checked Items
**Given** a calendar check was run 10 minutes ago and the interval is 1 hour
**When** the user runs `ivy-heartbeat check`
**Then** the calendar check is skipped and the summary notes "1 skipped (not due)"

### S-3: Run Once (Single Execution)
**Given** the command is invoked with `--once`
**When** all checks complete
**Then** the process exits cleanly (suitable for launchd/cron)

### S-4: Custom Config Path
**Given** the user has a checklist at a non-default location
**When** they run `ivy-heartbeat check --config ~/custom/heartbeat.md`
**Then** the custom file is parsed instead of the default

### S-5: Disabled Items Are Skipped
**Given** a checklist item has `enabled: false`
**When** the check runs
**Then** that item is skipped entirely (not counted as due or evaluated)

### S-6: Check Failure Is Non-Fatal
**Given** one checklist item's evaluator throws an error
**When** the check runs
**Then** the error is logged as an event, other items continue, and the process exits with code 0

### S-7: Empty Checklist
**Given** `~/.pai/IVY_HEARTBEAT.md` doesn't exist or has no items
**When** the user runs `ivy-heartbeat check`
**Then** it prints "No checklist items found" and exits cleanly

## Functional Requirements

### FR-1: Command Interface
```
ivy-heartbeat check [--once] [--config <path>] [--dry-run] [--verbose]
```

Options:
- `--once` — Run checks once and exit (default behavior, flag is for clarity)
- `--config <path>` — Custom checklist path (default: `~/.pai/IVY_HEARTBEAT.md`)
- `--dry-run` — Parse checklist and show what would run, but don't evaluate
- `--verbose` — Show detailed output per check item

Global options (`--json`, `--db`) from the CLI framework apply.

### FR-2: Agent Lifecycle
1. Register agent: `bb.registerAgent({ name: 'ivy-heartbeat', project: 'heartbeat-check' })`
2. Run checks (see FR-3 through FR-6)
3. Send final heartbeat with summary: `bb.sendHeartbeat({ sessionId, progress: '3/5 checks passed' })`
4. Deregister agent: `bb.deregisterAgent(sessionId)`

The entire check run is a single agent session. Registration and deregistration are always paired, even on error (use try/finally).

### FR-3: Checklist Loading
1. Parse checklist via `parseHeartbeatChecklist(configPath)` (F-006)
2. Filter to enabled items only (`item.enabled === true`)
3. If no enabled items, print message and exit

### FR-4: Due Check Logic
For each enabled item, determine if it's due by querying the blackboard:
1. Query recent events for this check: `bb.eventQueries.getByType('heartbeat_received', { limit: 1 })` filtered by summary containing the check name
2. If no previous run exists → item is due
3. If previous run exists, compare elapsed time against interval:
   - Default interval: 1 hour
   - Configurable per-item via `config.interval_minutes` in the checklist YAML

```typescript
interface DueCheckResult {
  item: ChecklistItem;
  isDue: boolean;
  lastRun: string | null;  // ISO timestamp
  reason: string;           // "never run" | "due (65m since last)" | "not due (10m ago)"
}
```

### FR-5: Check Evaluation
Each check type has an evaluator function:

```typescript
interface CheckResult {
  item: ChecklistItem;
  status: 'ok' | 'alert' | 'error';
  summary: string;
  details?: Record<string, unknown>;
}
```

**For F-007, evaluators are stubs** that return `ok` with a placeholder message. Actual evaluators (calendar API, email IMAP, custom scripts) are implemented in later features (F-017, F-018). The evaluator interface is what matters here.

```typescript
// Evaluator registry
const evaluators: Record<CheckType, (item: ChecklistItem) => Promise<CheckResult>> = {
  calendar: async (item) => ({ item, status: 'ok', summary: `Calendar check: ${item.name} (stub)` }),
  email: async (item) => ({ item, status: 'ok', summary: `Email check: ${item.name} (stub)` }),
  custom: async (item) => ({ item, status: 'ok', summary: `Custom check: ${item.name} (stub)` }),
};
```

### FR-6: Result Recording
For each evaluated item:
1. Send heartbeat: `bb.sendHeartbeat({ sessionId, progress: result.summary })`
2. Append event: `bb.appendEvent({ actorId: sessionId, summary: result.summary, metadata: { checkName: item.name, checkType: item.type, status: result.status, severity: item.severity, ...result.details } })`
3. If `status === 'alert'` and item has channels, note the alert (actual delivery is F-009)

### FR-7: Output Summary
After all checks:

```
ivy-heartbeat check — 2026-02-03T21:30:00Z
  ✓ Calendar Conflicts: ok (no conflicts found)
  ✓ Important Emails: ok (stub)
  ⚠ Custom Health: alert (disk usage 92%)
  ─ System Backup: skipped (not due, 30m ago)

3 checked, 1 alert, 1 skipped
```

With `--json`:
```json
{
  "ok": true,
  "checked": 3,
  "alerts": 1,
  "skipped": 1,
  "results": [...]
}
```

With `--dry-run`:
```
ivy-heartbeat check --dry-run
  → Calendar Conflicts: DUE (never run)
  → Important Emails: DUE (65m since last)
  → Custom Health: NOT DUE (30m ago, interval: 60m)
  ─ System Backup: disabled

2 would run, 1 not due, 1 disabled
```

## Architecture

```
src/commands/check.ts    — Commander command registration
src/check/runner.ts      — Orchestration: load → filter → due-check → evaluate → record
src/check/evaluators.ts  — Evaluator registry with stub implementations
src/check/due.ts         — Due-check logic (query blackboard, compare intervals)
src/check/types.ts       — DueCheckResult, CheckResult, CheckSummary types
```

## Dependencies
- F-001 (Blackboard library) — complete
- F-002 (CLI framework) — complete
- F-006 (IVY_HEARTBEAT.md parser) — complete

## Success Criteria

1. `ivy-heartbeat check` registers agent, runs checks, deregisters
2. Disabled items are skipped
3. Due-check logic correctly identifies items needing evaluation
4. Stub evaluators return ok for all check types
5. Results are recorded as heartbeats and events in the blackboard
6. `--dry-run` shows what would run without executing
7. `--verbose` shows per-item detail
8. `--json` produces structured output
9. Agent deregistration happens even on error (try/finally)
10. Empty or missing checklist is handled gracefully
