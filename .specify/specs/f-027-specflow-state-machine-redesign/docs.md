# SpecFlow State Machine — User Documentation

## What Changed

SpecFlow features now have a dedicated lifecycle table (`specflow_features`) in the blackboard. Instead of chaining work items between phases, a single orchestrator controls feature advancement based on verifiable conditions.

**Before:** Feature state lived in work item metadata, copied between items on each phase transition.
**After:** Feature state lives in one row in `specflow_features`, updated by the orchestrator.

## Feature Lifecycle

Features progress through these states automatically:

```
queued → specifying → specified → planning → planned →
  tasking → tasked → implementing → implemented →
  completing → completed
```

Active states (`*ing`) have a timeout. If a phase runs longer than `phase_timeout_min` (default: 30 minutes), the orchestrator releases it and retries from the last completed state.

## API Endpoints

### List All Features

```
GET /api/specflow
```

Optional query params: `project`, `phase`, `status`, `limit`

```json
{
  "features": [
    {
      "feature_id": "F-027",
      "title": "SpecFlow State Machine Redesign",
      "phase": "implementing",
      "status": "active",
      "failure_count": 0,
      "specify_score": 92,
      "plan_score": 88,
      "updated_at": "2026-02-26T09:30:00Z"
    }
  ],
  "total": 15
}
```

### Feature Detail

```
GET /api/specflow/:featureId
```

Returns full feature state including worktree path, branch, PR URL, and error history.

### Feature Event Timeline

```
GET /api/specflow/:featureId/events
```

Returns the complete audit trail of phase transitions, gate results, and agent sessions.

## Enabling the Orchestrator

The new orchestrator is controlled by a feature flag. During Phase 2 (dual-write), it runs in observation mode only. Set this in `.env` to activate it:

```bash
SPECFLOW_ORCHESTRATOR=true
```

When disabled (default), the existing `agent_dispatch` + `chainNextPhase` flow continues unchanged.

## Failure Handling

Each feature has a `failure_count` and `max_failures` (default: 3). When `failure_count >= max_failures`, the feature is marked `failed` and stops retrying.

To manually reset a stuck feature:
```bash
blackboard work update <work-item-id> --status pending
# or via future: blackboard specflow reset F-027
```

## Quality Gates

Every phase transition requires a gate to pass:

| Transition | Gate | Condition |
|-----------|------|-----------|
| specifying → specified | Eval | score ≥ 80, spec.md exists |
| planning → planned | Eval | score ≥ 80, plan.md exists |
| tasking → tasked | Artifact | tasks.md exists |
| implementing → implemented | Code | Non-spec source files changed |
| completing → completed | Artifact | PR created |

The **code gate** is new — it prevents docs-only PRs by verifying that at least one source file outside `.specify/`, `CHANGELOG.md`, `Plans/`, `docs/`, `README.md`, and `.claude/` was modified.

## Rollback

If the orchestrator causes issues, disable it immediately:

```bash
# In .env
SPECFLOW_ORCHESTRATOR=false
```

The old `chainNextPhase` flow resumes on the next heartbeat cycle. In-flight features continue via work items. The `specflow_features` table persists but is not used for dispatch.

## Dashboard

The existing dashboard at port 7878 gains a SpecFlow section showing all features and their current lifecycle state. The event timeline per feature provides a complete audit trail without needing to scan work items.
