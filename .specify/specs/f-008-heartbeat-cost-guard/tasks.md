# F-008: Heartbeat Cost Guard — Tasks

## Task 1: Create guard module
**File:** `src/check/guard.ts`
- [ ] Implement `computeChecklistHash(filePath: string): string` using Bun's crypto
- [ ] Implement `shouldSkip(dueResults: DueCheckResult[]): CostGuardResult`
- [ ] Export `CostGuardResult` type with `skip`, `reason`, `hash` fields

## Task 2: Update CheckSummary type
**File:** `src/check/types.ts`
- [ ] Add optional `skipped: boolean` flag to CheckSummary
- [ ] Add optional `guardResult?: CostGuardResult` to CheckSummary
- [ ] Add `force?: boolean` to CheckOptions

## Task 3: Integrate guard into runner
**File:** `src/check/runner.ts`
- [ ] After computing dueResults, call `shouldSkip()` if not `opts.force`
- [ ] If skip: record `heartbeat_skipped` event, return early summary
- [ ] If not skip: continue existing evaluation loop unchanged

## Task 4: Add --force flag to CLI
**File:** `src/commands/check.ts`
- [ ] Add `.option('--force', 'Force evaluation even if nothing is due')`
- [ ] Pass `force: opts.force` to runChecks options
- [ ] Handle skip output for terminal and JSON modes

## Task 5: Write tests
**File:** `test/check.test.ts`
- [ ] Test: all items not due → guard skips
- [ ] Test: some items due → guard allows
- [ ] Test: --force → guard bypassed
- [ ] Test: skip event recorded with hash
- [ ] Test: existing tests pass unchanged
