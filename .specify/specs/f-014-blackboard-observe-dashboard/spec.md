# F-014: Blackboard Observe CLI Dashboard

## What
Enhance the `observe` command with rich dashboard views:
- `--since <iso>` — What happened since a timestamp
- `--agent <id>` — Filter all views by agent
- `--summary` — Aggregate overview: event counts, active agents, last heartbeat
- `--heartbeats` already exists — enhance with last/next check info

## Acceptance Criteria
1. `observe --since` shows events after timestamp with count
2. `observe --agent` filters events by actor_id
3. `observe --summary` shows aggregate dashboard: counts by type, active agents, last heartbeat time
4. Enhanced heartbeat view shows last check time and status
5. All views support --json
6. Tests cover new flags and filtering
