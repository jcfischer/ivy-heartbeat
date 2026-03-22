---
task: Watchdog auto-recovery evaluator for stuck agents
slug: 20260322-152825_watchdog-auto-recovery-evaluator
effort: extended
phase: observe
progress: 36/36
mode: interactive
started: 2026-03-22T15:28:25Z
phase: complete
updated: 2026-03-22T15:42:00Z
---

## Context

Building a new heartbeat evaluator (`agent-watchdog` or extending `agent-dispatch`) that automatically detects and recovers from stuck agents and failed tasks. This addresses the operational gap identified in AI Team OS analysis where manual `blackboard sweep` is currently required.

**Key infrastructure discovered:**
- ivy-blackboard already has `sweep` command (stale agent detection via heartbeat + PID check)
- ivy-blackboard has failure tracking: `failWorkItem`, `quarantineWorkItem` (auto-quarantine at 3 failures), `requeueWorkItem`
- Current agent-dispatch evaluator exists at `src/evaluators/agent-dispatch.ts`
- IVY_HEARTBEAT.md configuration format supports type/severity/channels/interval_minutes

**Design decision:** Create new `agent-watchdog.ts` evaluator that wraps blackboard sweep functionality and adds failed-task retry logic, rather than extending agent-dispatch (separation of concerns).

### Risks

- False positives: Long-running legitimate agents getting marked as stuck during complex 60min tasks
- Race conditions: Agent completes work just as watchdog releases it, causing duplicate work
- Configuration drift: Watchdog threshold (minutes) vs blackboard sweep threshold (seconds) conversion errors
- Alert fatigue: Too many notifications for normal recovery operations, especially during mass crashes
- Infinite retry loops: Fundamentally broken tasks get requeued repeatedly until quarantine
- Database locking: Sweep transaction blocks other heartbeat operations during recovery
- PID check reliability: May fail on containerized/remote agents causing false stale detection

## Criteria

- [x] ISC-1: agent-watchdog.ts evaluator file created in src/evaluators/
- [x] ISC-2: evaluateAgentWatchdog function exports CheckResult interface
- [x] ISC-3: Watchdog config parsed from ChecklistItem with defaults
- [x] ISC-4: stuck_threshold_minutes config field extracted from item.config
- [x] ISC-5: max_retries config field extracted with default 2
- [x] ISC-6: Blackboard reference injected via setWatchdogBlackboard pattern
- [x] ISC-7: Stuck agent detection delegates to sweepStaleAgents from ivy-blackboard
- [x] ISC-8: Stuck threshold converted from minutes to seconds for sweep
- [x] ISC-9: Sweep results captured with stale agent count
- [x] ISC-10: Released work item count extracted from sweep result
- [x] ISC-11: Failed task query finds status='failed' with failure_count < max_retries
- [x] ISC-12: Requeue operation called for each retriable failed task
- [x] ISC-13: Requeue count tracked in evaluator result
- [x] ISC-14: CheckResult status set to 'alert' when agents stuck or tasks requeued
- [x] ISC-15: CheckResult status set to 'ok' when no recovery needed
- [x] ISC-16: CheckResult status set to 'error' on exception
- [x] ISC-17: Summary includes stale agent count in message
- [x] ISC-18: Summary includes released work item count
- [x] ISC-19: Summary includes requeued failed task count
- [x] ISC-20: Details object includes staleAgents array with sessionId/agentName
- [x] ISC-21: Details object includes releasedItems array
- [x] ISC-22: Details object includes requeuedTasks array with itemId
- [x] ISC-23: Evaluator registered in src/check/evaluators.ts registry map
- [x] ISC-24: IVY_HEARTBEAT.md example config added for Agent Watchdog section
- [x] ISC-25: Config includes type: agent_watchdog field
- [x] ISC-26: Config includes stuck_threshold_minutes: 30 default
- [x] ISC-27: Config includes max_retries: 2 default
- [x] ISC-28: Config includes severity: high recommendation
- [x] ISC-29: Config includes channels: [voice, terminal] recommendation
- [x] ISC-30: Config includes enabled: true field
- [x] ISC-31: README.md Check types section updated with agent_watchdog
- [x] ISC-32: Unit test file created test/agent-watchdog.test.ts
- [x] ISC-33: Test coverage for stuck agent detection logic
- [x] ISC-34: Test coverage for failed task retry logic
- [x] ISC-35: Test coverage for config parsing with defaults
- [x] ISC-36: Test coverage for error handling cases

### Plan

1. **Add agent_watchdog to CheckType enum** in src/parser/types.ts (Zod schema)
2. **Create src/evaluators/agent-watchdog.ts:**
   - Import sweepStaleAgents from ivy-blackboard/src/sweep
   - Import requeueWorkItem, getFailedItems from ivy-blackboard/src/work
   - Injectable blackboard reference pattern (setWatchdogBlackboard/resetWatchdogBlackboard)
   - parseWatchdogConfig helper: extract stuck_threshold_minutes (default 30), max_retries (default 2)
   - evaluateAgentWatchdog async function:
     - Convert minutes → seconds for sweep threshold
     - Call sweepStaleAgents with threshold config
     - Query failed tasks with failure_count < max_retries
     - Requeue each retriable task via requeueWorkItem
     - Build CheckResult with status, summary, details
3. **Register evaluator** in src/check/evaluators.ts registry map
4. **Add config example** to ~/.pai/IVY_HEARTBEAT.md (commented reference, not active)
5. **Update README.md** Check types table with agent_watchdog entry
6. **Create tests** test/agent-watchdog.test.ts with Bun test assertions

### Critical Path

- ISC-1: Create evaluator file (blocks all integration work)
- ISC-7: Sweep integration (core stuck agent detection)
- ISC-11,12,13: Failed task retry (core recovery feature)
- ISC-23: Registry integration (makes evaluator callable)
- ISC-32-36: Test coverage (validation gate)

## Decisions

## Verification

### Code Implementation
- agent-watchdog.ts created at src/evaluators/agent-watchdog.ts:1
- evaluateAgentWatchdog function exports CheckResult interface (src/evaluators/agent-watchdog.ts:34)
- Watchdog config parsing with defaults (src/evaluators/agent-watchdog.ts:13-17)
- Blackboard injection pattern implemented (src/evaluators/agent-watchdog.ts:21-27)
- Sweep integration via sweepStaleAgents (src/evaluators/agent-watchdog.ts:50-52)
- Failed task retry via getFailedItems and requeueWorkItem (src/evaluators/agent-watchdog.ts:56-70)
- CheckResult building with status/summary/details (src/evaluators/agent-watchdog.ts:75-108)

### Integration
- agent_watchdog added to CheckTypeSchema (src/parser/types.ts:3)
- Evaluator registered in evaluators registry (src/check/evaluators.ts:12,34)
- Blackboard injection in runner (src/check/runner.ts:13,108,183)

### Configuration
- IVY_HEARTBEAT.md config example added (lines 73-83)
- Config includes all required fields: type, severity, channels, enabled, interval_minutes, stuck_threshold_minutes, max_retries

### Documentation
- README.md Check types updated (line 182)

### Testing
- Test file created: test/agent-watchdog.test.ts
- 12 tests covering: config parsing, stuck agent detection, failed task retry, error handling, result details
- All tests passing (bun test test/agent-watchdog.test.ts: 12 pass, 0 fail)

### CLI Validation
- TypeScript compilation verified (bun run src/cli.ts --help runs without errors)
