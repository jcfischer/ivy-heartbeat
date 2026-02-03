# F-003: Implementation Plan

## Status: DELEGATED TO ivy-blackboard

No ivy-heartbeat implementation needed. Core event operations are handled by ivy-blackboard.

### What ivy-heartbeat provides (already implemented):
- `Blackboard.appendEvent()` — convenience method using `heartbeat_received` event type
- `EventQueryRepository` — read-only queries (getRecent, getSince, getByType, getByActor)
- `ivy-heartbeat observe --events` CLI command (F-002)

### What ivy-blackboard provides:
- Events table schema with CHECK constraint on event_type
- Event insertion via agent lifecycle functions (registerAgent, deregisterAgent, sendHeartbeat)
- `blackboard observe` CLI command with full filtering
