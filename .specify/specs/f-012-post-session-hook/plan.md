# F-012: Plan

## Files
- `src/hooks/post-session.ts` — Main hook script (executable)
- `src/hooks/transcript.ts` — JSONL transcript parser
- `src/hooks/extractor.ts` — Fact/pattern extraction from messages
- `test/post-session.test.ts` — Tests

## Approach
1. Parse JSONL: each line is a JSON object with role, content, tool_use, etc.
2. Extract session metadata: first/last timestamps, files mentioned, tools used
3. Extract facts: look for patterns like "decided to", "changed from", "key insight"
4. Write events to blackboard via Blackboard class
5. The hook script itself is a CLI entry point that can be registered with Claude Code
