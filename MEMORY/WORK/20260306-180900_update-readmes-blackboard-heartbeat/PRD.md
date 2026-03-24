---
task: Update READMEs for blackboard and heartbeat repos
slug: 20260306-180900_update-readmes-blackboard-heartbeat
effort: standard
phase: complete
progress: 12/12
mode: interactive
started: 2026-03-06T18:09:00Z
updated: 2026-03-06T18:20:00Z
---

## Context

Update READMEs in both repos to reflect recent changes. ivy-blackboard gained specflow_features table (V6) and failure tracking columns on work_items (V7). ivy-heartbeat gained new scheduler architecture (specflow subdirs), new evaluators, new CLI commands, updated test count (580/39), and new env vars.

## Criteria

- [ ] ISC-1: ivy-blackboard README database tables list includes specflow_features
- [ ] ISC-2: ivy-blackboard README architecture note mentions failure tracking columns on work_items
- [ ] ISC-3: ivy-heartbeat README test count updated to 580 tests across 39 files
- [ ] ISC-4: ivy-heartbeat README architecture adds github-issues.ts and github-pr-review.ts evaluators
- [ ] ISC-5: ivy-heartbeat README architecture shows specflow/ subdir with phases gates infra utils
- [ ] ISC-6: ivy-heartbeat README architecture adds reflect-handler.ts and reflect.ts to scheduler
- [ ] ISC-7: ivy-heartbeat README CLI commands table lists retry command
- [ ] ISC-8: ivy-heartbeat README CLI commands table lists specflow-queue command
- [ ] ISC-9: ivy-heartbeat README environment variables lists SPECFLOW_ORCHESTRATOR
- [ ] ISC-10: ivy-heartbeat README SpecFlow section mentions specflow_features cross-project tracking
- [ ] ISC-11: ivy-blackboard committed and pushed
- [ ] ISC-12: ivy-heartbeat committed and pushed

## Decisions

Keep changes factual and minimal — only document what exists in code. Don't add commands that aren't wired to CLI. Don't mention internal-only workers (dispatch-worker, specflow-phase-worker) in user-facing command table.

## Verification
