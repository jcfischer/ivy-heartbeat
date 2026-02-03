# F-011: Plan

## Approach
1. Add FTS5 setup to Blackboard constructor — create virtual table + triggers if not exists
2. Add `search()` method to EventQueryRepository using FTS5 MATCH syntax
3. Add `search` CLI command to src/commands/
4. Wire into cli.ts

## Files to Create/Modify
- `src/fts.ts` — FTS5 setup function (CREATE VIRTUAL TABLE, triggers)
- `src/repositories/events.ts` — Add search() method
- `src/commands/search.ts` — CLI search command
- `src/cli.ts` — Register search command
- `src/blackboard.ts` — Call FTS setup in constructor
- `test/fts.test.ts` — FTS5 tests

## Key Decisions
- Content-sync FTS5 (content=events, content_rowid=id) — no data duplication
- Index `summary` and `metadata` columns only
- Use bun:sqlite's built-in FTS5 support
- Triggers handle insert/delete sync automatically
