# F-003: Blackboard Events Append and Query

## Status: DELEGATED TO ivy-blackboard

### What Changed

The original spec assumed ivy-heartbeat would own event append/query operations with its own CLI (`blackboard observe`). With the architecture change:

- **ivy-blackboard** now owns the events table schema, event appending (via agent lifecycle functions), and the `blackboard observe` CLI command.
- **ivy-heartbeat** provides:
  - `Blackboard.appendEvent()` — a convenience method that inserts events using the `heartbeat_received` type (workaround for ivy-blackboard's CHECK constraint, see issue #2).
  - `EventQueryRepository` — read-only queries: `getRecent()`, `getSince()`, `getByType()`, `getByActor()`.
  - `ivy-heartbeat observe --events` CLI command (implemented in F-002).

### What's Implemented

| Capability | Owner | Status |
|-----------|-------|--------|
| Event table schema | ivy-blackboard | Done |
| Event appending (agent lifecycle) | ivy-blackboard | Done |
| Event appending (heartbeat-specific) | ivy-heartbeat `Blackboard.appendEvent()` | Done |
| Event query repository | ivy-heartbeat `EventQueryRepository` | Done |
| `blackboard observe --events` CLI | ivy-blackboard | Done |
| `ivy-heartbeat observe --events` CLI | ivy-heartbeat | Done (F-002) |

### Remaining Work

- When ivy-blackboard resolves issue #2 (event_type CHECK constraint), update `Blackboard.appendEvent()` to use heartbeat-specific event types instead of generic `heartbeat_received`.

### Original Dependencies
- F-001 (Blackboard TypeScript library) — completed

### Original Success Criteria (Disposition)

1. ~~Events append correctly with auto-timestamp~~ → Handled by ivy-blackboard
2. ~~`--type` filter returns only matching events~~ → Implemented in EventQueryRepository.getByType()
3. ~~`--since` filter handles relative and absolute times~~ → EventQueryRepository.getSince() accepts ISO timestamps; relative time parsing not implemented (not needed for programmatic use)
4. ~~`--agent` filter matches by agent name~~ → EventQueryRepository.getByActor() filters by actor_id
5. ~~`--limit` controls output count~~ → Implemented in CLI observe command
6. ~~Table output is readable~~ → Uses ivy-blackboard's formatTable
