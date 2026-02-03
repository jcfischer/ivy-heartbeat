# F-015: Blackboard Serve Web Dashboard

## What
Bun HTTP server at localhost:7878 serving a static HTML dashboard with:
- Event stream (recent events table with auto-refresh)
- Heartbeat timeline (latest heartbeats)
- Summary stats (agent count, event count, last check)
- FTS5 search interface
- JSON API endpoints for all data

## Acceptance Criteria
1. `ivy-heartbeat serve` starts HTTP server on localhost:7878
2. GET / returns HTML dashboard page
3. GET /api/events returns JSON event list
4. GET /api/heartbeats returns JSON heartbeat list
5. GET /api/summary returns JSON summary data
6. GET /api/search?q=query returns FTS5 search results
7. Localhost-only binding (127.0.0.1)
8. Server supports --port flag
9. Tests cover API endpoints and server lifecycle
