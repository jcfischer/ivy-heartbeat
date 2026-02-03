# F-007: Heartbeat Check Command — Documentation

## Overview

`ivy-heartbeat check` is the core runtime command. It parses the checklist, determines which items are due, evaluates them via type-specific evaluators, and records results to the blackboard.

## Usage

```bash
# Run all due checks
ivy-heartbeat check

# Dry-run: see what would execute
ivy-heartbeat check --dry-run

# Custom checklist path
ivy-heartbeat check --config ~/custom/heartbeat.md

# JSON output
ivy-heartbeat --json check
```

## Architecture

```
src/check/types.ts       — DueCheckResult, CheckResult, CheckSummary
src/check/due.ts         — isDue() queries blackboard for last run per item
src/check/evaluators.ts  — Evaluator registry (stubs for now)
src/check/runner.ts      — runChecks() orchestration pipeline
src/commands/check.ts    — CLI command wiring
```

## Evaluators

F-007 provides stub evaluators that return `ok` for all check types. Real implementations:
- Calendar: F-018
- Email: F-017
- Custom: future

The evaluator interface is async to support API calls:
```typescript
type Evaluator = (item: ChecklistItem) => Promise<CheckResult>;
```

Custom evaluators can be registered:
```typescript
import { registerEvaluator } from './check/evaluators';
registerEvaluator('calendar', myCalendarEvaluator);
```

## Due-Check Logic

Items are due when:
- Never been run before
- Elapsed time since last run exceeds interval (default: 60 minutes)
- Custom interval via `config.interval_minutes` in checklist YAML

## Pre-Verification Checklist

- [x] `ivy-heartbeat check` registers agent, runs checks, deregisters
- [x] Disabled items are skipped
- [x] Due-check logic identifies items needing evaluation
- [x] Stub evaluators return ok for all types
- [x] Results recorded as heartbeats and events
- [x] `--dry-run` shows what would run
- [x] `--json` produces structured output
- [x] Agent deregistration happens even on error
- [x] Empty/missing checklist handled gracefully
- [x] 71 tests pass
