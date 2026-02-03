# F-008: Heartbeat Cost Guard — Documentation

## Overview

The cost guard is an optimization that skips the evaluation loop when no checklist items are due. This prevents unnecessary work when the heartbeat runs on a fixed schedule (launchd every hour) but all items were recently checked.

## Usage

```bash
# Normal run — guard may skip if nothing is due
ivy-heartbeat check

# Force evaluation even if guard would skip
ivy-heartbeat check --force

# JSON output includes guard state
ivy-heartbeat --json check
```

## How It Works

After computing due status for all enabled items, the guard checks if any items are actually due. If zero items are due:
1. A `heartbeat_skipped` event is recorded to the blackboard with the checklist hash
2. The evaluation loop is skipped entirely
3. A short "skipped" message is printed

The guard does NOT interfere with `--dry-run` (which returns before the guard runs).

## Architecture

```
src/check/guard.ts   — computeChecklistHash(), shouldSkip()
src/check/runner.ts  — Guard integrated before evaluation loop
src/check/types.ts   — guardSkipped, guardResult added to CheckSummary
src/commands/check.ts — --force flag, printSkipped() output
```

## Pre-Verification Checklist

- [x] Guard skips when zero items are due
- [x] Skip event recorded to blackboard with hash
- [x] `--force` bypasses guard
- [x] Checklist hash included in skip events
- [x] Terminal skip output: "skipped (no items due, N enabled)"
- [x] JSON output includes guardSkipped and guardResult
- [x] Existing tests pass unchanged
- [x] dry-run not affected by guard
- [x] 106 tests pass (14 new guard tests)
