# F-008: Heartbeat Cost Guard — Plan

## File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `src/check/guard.ts` | CREATE | Hash computation, guard logic |
| `src/check/runner.ts` | MODIFY | Insert guard before evaluation loop |
| `src/check/types.ts` | MODIFY | Add `skipped` flag and guard fields to CheckSummary |
| `src/commands/check.ts` | MODIFY | Add `--force` flag, handle skip output |
| `test/check.test.ts` | MODIFY | Add guard tests |

## Approach

The cost guard is a simple optimization: if no items are due, skip the evaluation loop entirely. The existing `isDue()` logic already determines this. The guard adds:
1. A hash of the checklist file for event metadata (not for skip decision)
2. A skip event recorded to the blackboard
3. A `--force` flag to bypass

The skip decision is: `dueResults.every(d => !d.isDue)` — all items are not due, so nothing to evaluate. This already happens naturally (the loop skips non-due items), but the guard short-circuits earlier and records a proper skip event.

## Test Strategy

- Unit test: guard hash computation
- Unit test: guard detects no items due → skip
- Unit test: guard allows when items are due
- Unit test: --force bypasses guard
- Integration: skip event recorded to blackboard
- Existing tests: must pass unchanged
