# F-007: Implementation Plan

## Approach

Build the `check` command as the core runtime for ivy-heartbeat. Split into four focused modules: types, due-check logic, evaluator registry, and runner orchestration. Register the command in the existing CLI framework.

## Architecture

```
src/check/types.ts       — DueCheckResult, CheckResult, CheckSummary
src/check/due.ts         — isDue() queries blackboard for last run per item
src/check/evaluators.ts  — Evaluator registry (stubs for F-007, real implementations later)
src/check/runner.ts      — runChecks() orchestration: load → filter → due → evaluate → record
src/commands/check.ts    — Commander command wiring
```

## Key Decisions

1. **Evaluators are async** — Even though stubs are sync, the interface is `async` because real evaluators will call APIs (calendar, IMAP, scripts).
2. **Stubs return `ok`** — Real evaluators come in F-017 (email), F-018 (calendar). The interface and orchestration are what F-007 delivers.
3. **Due-check uses event summary matching** — Query `heartbeat_received` events and match on check name in the summary. This is pragmatic given the CHECK constraint (issue #2). When custom event types become available, this can use event metadata instead.
4. **Default interval: 60 minutes** — Overridable per-item via `config.interval_minutes` in the YAML.
5. **Agent session wraps entire run** — Single register/deregister pair, not per-item. Heartbeats sent per-item as progress updates.

## Files to Create

| File | Purpose | Lines (est.) |
|------|---------|-------------|
| `src/check/types.ts` | Type definitions | ~30 |
| `src/check/due.ts` | Due-check logic | ~40 |
| `src/check/evaluators.ts` | Evaluator registry + stubs | ~30 |
| `src/check/runner.ts` | Orchestration | ~80 |
| `src/commands/check.ts` | CLI command | ~70 |
| `test/check.test.ts` | Tests | ~120 |

## Files to Modify

| File | Change |
|------|--------|
| `src/cli.ts` | Import and register check command |

## Test Strategy

- Test `isDue()` with mock blackboard data (no previous run, recent run, stale run)
- Test `runChecks()` with various checklist configurations (empty, all enabled, mixed, disabled)
- Test runner handles evaluator errors gracefully
- Test dry-run mode returns results without recording
- Test agent lifecycle (register/deregister always paired)
