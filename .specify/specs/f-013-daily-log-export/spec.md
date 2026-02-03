# F-013: Daily Log Export

## What
CLI command: `ivy-heartbeat export --date YYYY-MM-DD` that generates a Markdown
daily log from the events table. Includes sessions, heartbeat checks, facts,
patterns, and credential events for that day.

## Acceptance Criteria
1. `ivy-heartbeat export --date 2026-02-03` outputs Markdown to stdout
2. Groups events by type: sessions, checks, facts, credentials
3. Shows event count summary at top
4. Supports --json for structured output
5. Defaults to today when no --date given
6. Returns empty log message when no events for date
7. Tests cover log generation, date filtering, empty days
