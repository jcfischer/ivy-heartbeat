# F-011: FTS5 Virtual Table on Events

## What
Add SQLite FTS5 full-text search on the events table (summary + metadata columns).
Create the virtual table and sync triggers in ivy-heartbeat's Blackboard constructor.
Add a `search(query)` method to EventQueryRepository and a `search` CLI command.

## Why
Events accumulate rapidly. Grep-style filtering by type or actor is insufficient
for finding specific sessions, facts, or patterns. FTS5 enables sub-100ms
full-text search across all event data.

## Acceptance Criteria
1. `events_fts` virtual table created on Blackboard init (idempotent)
2. Insert trigger keeps FTS index in sync with events table
3. Delete trigger removes stale FTS entries
4. `EventQueryRepository.search(query, opts?)` returns matching events ranked by relevance
5. `ivy-heartbeat search <query>` CLI command with --limit, --json flags
6. Search completes in <100ms for 10k events
7. Existing tests still pass (no schema breakage)
