# Documentation Updates: F-020 PR Review Feedback Loop

## Files Changed

### New Files
- `src/scheduler/pr-comments.ts` — Fetches and parses GitHub PR review comments via `gh api`
- `tests/pr-comments.test.ts` — 152 lines of tests for PR comment parsing

### Modified Files
- `src/scheduler/rework.ts` — Enhanced rework agent prompt with review comment context
- `src/scheduler/scheduler.ts` — Import for pr-comments integration
- `src/scheduler/worktree.ts` — Added `getDiffSummary()` helper for branch diff extraction
- `tests/rework.test.ts` — Extended test coverage for rework with review feedback

## README Updates
No README changes needed — this is internal scheduler infrastructure not exposed to CLI users.

## CLAUDE.md Updates
No CLAUDE.md changes needed.
