---
task: Fix F-124 quality gate and orchestrator interval
slug: 20260306-191500_fix-f124-quality-gate-orchestrator-interval
effort: standard
phase: execute
progress: 6/6
mode: interactive
started: 2026-03-06T19:15:00Z
updated: 2026-03-06T20:10:00Z
---

## Context
F-124 quality gate was returning score 0 with `claude CLI exited with status null`. Root cause: Claude CLI fails when invoked from inside a git worktree (CWD = worktree path).

## Fix
`checkGateAndAdvance` now looks up `project.local_path` via `bb.getProject()` and passes it to `checkQualityGate` for quality gates. Spec artifacts live in the main repo (symlinked into worktrees), so main repo path is correct.

## Changes
- `src/scheduler/specflow/orchestrator.ts`: Use `project.local_path ?? worktreePath` for quality gate CWD
- `~/.pai/IVY_HEARTBEAT.md`: orchestrator `interval_minutes: 9` → `4`
- `specflow_features` DB: Reset F-124 `failure_count=0, status=succeeded` for retry
- Commit: `9783c80` on main

## Outcome
- Quality gate now scores 0.76 (real score, not null) → orchestrator will re-plan
- F-119 advanced to `completing/active` on first post-fix cycle
- 580/580 tests pass
