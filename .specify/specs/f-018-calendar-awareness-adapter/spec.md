# F-018: Calendar Awareness Adapter

## What
Replace the calendar evaluator stub with a real implementation that reads
upcoming events from macOS Calendar via the `ical` CLI tool, detects
scheduling conflicts, and alerts when conflicts or prep-needed events exist.

## MVP Approach
Uses the `ical` CLI (at ~/.claude/skills/Calendar/ical) to read macOS
Calendar events. If the CLI is not available, gracefully degrades to ok.

Config fields:
- `lookahead_hours` — how far ahead to check (default: 24)
- `calendar_name` — specific calendar to check (optional)
- `conflict_threshold` — overlapping events to trigger alert (default: 1)

## Acceptance Criteria
1. Calendar evaluator uses `ical read` CLI when available
2. Detects overlapping events (conflicts) within lookahead window
3. Returns alert when conflicts found, ok when clear
4. Gracefully handles missing ical CLI
5. Respects lookahead_hours and calendar_name config
6. Tests cover conflict detection logic, missing CLI, no conflicts
