# F-012: Post-Session Hook

## What
A post-session script that fires after each Claude Code session. Reads the session
transcript from the JSONL file, extracts key facts and patterns, and writes structured
events to the blackboard (session_started, session_activity, session_ended, fact_extracted,
pattern_detected).

## Why
Automatic session logging enables awareness of what happened across sessions.
The blackboard becomes the system's memory of past work.

## Approach
Since ivy-heartbeat events use 'heartbeat_received' type (CHECK constraint),
we differentiate via metadata fields. The hook is a standalone script that:
1. Receives the session JSONL path as argument
2. Parses the transcript to extract summary, files changed, duration
3. Uses simple heuristics (not AI inference in MVP) to extract facts
4. Writes events to the blackboard

## Acceptance Criteria
1. `src/hooks/post-session.ts` script — runnable via `bun`
2. Parses JSONL transcript to extract session metadata
3. Records session_started event with project path and session ID
4. Records session_activity event with files changed, tools used
5. Records session_ended event with duration
6. Extracts simple facts from assistant messages (patterns, decisions)
7. Installable hook at `~/.claude/hooks/`
8. Tests cover transcript parsing and event recording
