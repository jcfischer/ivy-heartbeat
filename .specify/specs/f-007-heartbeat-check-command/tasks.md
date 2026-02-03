# F-007: Tasks

## T-1: Create check types (src/check/types.ts)
- [ ] DueCheckResult interface (item, isDue, lastRun, reason)
- [ ] CheckResult interface (item, status: ok/alert/error, summary, details)
- [ ] CheckSummary interface (checked, alerts, skipped, results)

## T-2: Implement due-check logic (src/check/due.ts)
- [ ] `isDue(item, bb)` — query blackboard events for last run of this check
- [ ] Match by check name in event summary/metadata
- [ ] Compare elapsed time against interval (default 60m, per-item override)
- [ ] Return DueCheckResult with reason string

## T-3: Create evaluator registry (src/check/evaluators.ts)
- [ ] Evaluator type: `(item: ChecklistItem) => Promise<CheckResult>`
- [ ] Registry: `Record<CheckType, Evaluator>`
- [ ] Stub implementations for calendar, email, custom (all return ok)

## T-4: Build runner orchestration (src/check/runner.ts)
- [ ] `runChecks(bb, opts)` — main orchestration function
- [ ] Load checklist via parseHeartbeatChecklist()
- [ ] Filter enabled items
- [ ] Check due status for each item
- [ ] Evaluate due items (skip not-due)
- [ ] Record results: sendHeartbeat + appendEvent per item
- [ ] Handle evaluator errors (catch, log as error event, continue)
- [ ] Return CheckSummary

## T-5: Wire CLI command (src/commands/check.ts)
- [ ] `ivy-heartbeat check` command with --once, --config, --dry-run, --verbose options
- [ ] Agent lifecycle: register → runChecks → final heartbeat → deregister
- [ ] try/finally for guaranteed deregistration
- [ ] Text output: per-item status lines + summary
- [ ] JSON output mode
- [ ] Dry-run mode: show due status without evaluating
- [ ] Register command in src/cli.ts

## T-6: Write tests (test/check.test.ts)
- [ ] isDue: no previous run → due
- [ ] isDue: recent run within interval → not due
- [ ] isDue: stale run past interval → due
- [ ] isDue: custom interval_minutes from config
- [ ] runChecks: empty checklist → graceful exit
- [ ] runChecks: all enabled items evaluated
- [ ] runChecks: disabled items skipped
- [ ] runChecks: evaluator error caught and logged
- [ ] runChecks: results recorded to blackboard (heartbeats + events)
- [ ] runChecks: dry-run mode doesn't record
- [ ] Agent lifecycle: deregister always called (even on error)
