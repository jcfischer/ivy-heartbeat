# F-019: SpecFlow Dispatch Agent

## Overview

### Problem Statement

ivy-heartbeat currently dispatches only bug-fix agents for GitHub issues. Each dispatched agent runs a single Claude Code session in an isolated git worktree, then commits, pushes, and creates a PR. There is no support for dispatching agents that build new features using structured spec-driven development (SpecFlow), which requires multiple sequential phases with quality gates between them.

### Solution Summary

A new dispatch agent type that runs SpecFlow phases (specify, plan, tasks, implement, complete) as **chained work items** on the blackboard. Each phase is a separate work item that, on success, creates the next phase's work item. All phases for a single feature run in a **persistent git worktree** that lives until the feature pipeline completes or a staleness TTL expires. The worker shells out to the `specflow` CLI for each phase, passing eval feedback as retry context on quality gate failures. On implement success, the worker commits, pushes, and creates a PR — identical to the existing GitHub issue post-agent git flow.

### Approach

**Phase-per-Work-Item Architecture (Approach A)**

Each SpecFlow phase maps to a separate blackboard work item:

```
[available] specflow:F-1:specify  →  dispatch  →  [completed]
                                      ↓ creates
[available] specflow:F-1:plan     →  dispatch  →  [completed]
                                      ↓ creates
[available] specflow:F-1:tasks    →  dispatch  →  [completed]
                                      ↓ creates
[available] specflow:F-1:implement →  dispatch  →  [completed] → commit/push/PR
```

Work items interleave in the shared priority queue with GitHub issue items. Between phases, the dispatch slot is released, allowing other work items (including GitHub issues) to run.

## User Scenarios

### US-1: Manual SpecFlow Feature Dispatch

**Given** a project is registered on the blackboard with `specflow_enabled: true` and has `.specflow/features.db` with a pending feature F-019
**When** the user runs `ivy-heartbeat specflow-queue --project ivy-heartbeat --feature F-019`
**Then** a work item is created with `source: 'specflow'`, `metadata: { specflow_feature_id: 'F-019', specflow_phase: 'specify', project_id: 'ivy-heartbeat' }`
**And** the next `ivy-heartbeat dispatch` cycle picks it up and runs `specflow specify F-019 --batch` in an isolated worktree

### US-2: Autonomous Phase Chaining

**Given** a SpecFlow work item for phase "specify" has completed successfully (quality gate passed)
**When** the dispatch worker finishes the specify phase
**Then** a new work item is created for the "plan" phase with the same `specflow_feature_id` and the worktree path in metadata
**And** the "plan" work item enters the shared priority queue as available

### US-3: Quality Gate Failure with Auto-Retry

**Given** a SpecFlow work item for phase "plan" runs and the quality gate returns 65% (below 80% threshold)
**When** the dispatch worker detects the gate failure
**Then** the worker creates a new work item for the same phase ("plan") with retry context containing the eval feedback
**And** the retried agent receives the feedback in its prompt so it can address the issues
**And** the maximum retry count is tracked (default: 1 retry per phase)

### US-4: Feature Request GitHub Issue

**Given** a GitHub issue is labeled `feature-request` on a specflow-enabled project
**When** the github-issues evaluator detects it
**Then** a SpecFlow work item chain is created instead of a simple bug-fix work item
**And** the specify phase uses batch mode with decomposition data extracted from the issue body

### US-5: Dashboard Pipeline View

**Given** multiple SpecFlow features are in various phases of completion
**When** the user views the web dashboard
**Then** a dedicated SpecFlow pipeline view shows each feature's phase progression (specify ✓ → plan ✓ → tasks ○ → implement ○)
**And** the unified work item view shows SpecFlow items alongside GitHub items with source and phase metadata visible

### US-6: Implement Success with PR

**Given** a SpecFlow work item for phase "implement" has completed (exit 0, code changes present)
**When** the dispatch worker finishes the implement phase
**Then** the worker commits all changes, pushes the branch, and creates a PR
**And** the PR title references the SpecFlow feature ID and name
**And** the PR body includes a summary of the SpecFlow pipeline (link to spec, plan)
**And** the worktree is cleaned up after PR creation

### US-7: Implement Success with No Changes

**Given** a SpecFlow work item for phase "implement" completes but the agent produces no code changes
**When** the dispatch worker checks for git diff
**Then** the feature is marked as completed without creating a PR
**And** an event is logged explaining no changes were needed

### US-8: Worktree Staleness Cleanup

**Given** a SpecFlow feature's worktree was created 14 days ago and no phase has run in 7 days
**When** the heartbeat check runs
**Then** the stale worktree is pruned
**And** an event is logged with the cleanup details

## Functional Requirements

### FR-1: Work Item Source Type

The system MUST support a new work item source `specflow` alongside the existing `github` source. SpecFlow work items carry metadata:

```typescript
interface SpecFlowWorkItemMetadata {
  specflow_feature_id: string;     // e.g., "F-019"
  specflow_phase: SpecFlowPhase;   // "specify" | "plan" | "tasks" | "implement" | "complete"
  specflow_project_id: string;     // blackboard project ID
  worktree_path?: string;          // persistent worktree path (set after first phase)
  main_branch?: string;            // branch to base worktree from
  retry_count?: number;            // number of retries for this phase
  eval_feedback?: string;          // feedback from failed quality gate (for retries)
}
```

### FR-2: Dispatch Worker SpecFlow Code Path

The dispatch worker (`dispatch-worker.ts`) MUST detect `source === 'specflow'` work items and execute the SpecFlow-specific lifecycle:

1. **First phase (specify):** Create worktree, store path in metadata, run `specflow specify <feature-id> --batch` in worktree
2. **Middle phases (plan, tasks):** Reuse worktree from metadata, run `specflow <phase> <feature-id>` in worktree
3. **Implement phase:** Reuse worktree, run `specflow implement --feature <feature-id>` in worktree, then commit/push/PR on success
4. **Complete phase:** Run `specflow complete <feature-id>` for final validation

### FR-3: Work Item Chaining

On successful completion of a phase, the dispatch worker MUST create the next phase's work item automatically:

- `specify` (pass gate) → creates `plan` work item
- `plan` (pass gate) → creates `tasks` work item
- `tasks` → creates `implement` work item
- `implement` (success) → creates `complete` work item
- `complete` → marks the overall feature pipeline as done

The new work item MUST inherit: project_id, priority, specflow_feature_id, worktree_path, main_branch.

### FR-4: Quality Gate Integration

After specify and plan phases, the worker MUST check the SpecFlow quality gate:

- Run `specflow eval run --file <artifact> --rubric <rubric> --json` to get the score
- If score >= threshold (default 80%): proceed to create next phase work item
- If score < threshold: create a retry work item for the same phase with `eval_feedback` in metadata and `retry_count` incremented
- Maximum retries per phase: 1 (configurable). After max retries, mark work item as failed.

### FR-5: Persistent Worktrees

SpecFlow worktrees MUST persist across phases:

- Location: `~/.pai/worktrees/{projectId}/specflow-{featureId}/`
- Created during the first phase (specify), reused by subsequent phases
- Cleaned up after: (a) successful complete phase, (b) pipeline failure after max retries, (c) staleness TTL expiry
- Staleness TTL: 7 days of inactivity (configurable)

### FR-6: Manual CLI Trigger

A new CLI command `ivy-heartbeat specflow-queue` MUST allow manual queuing of SpecFlow features:

```
ivy-heartbeat specflow-queue --project <project-id> --feature <feature-id> [--priority <n>]
```

This creates the initial "specify" work item on the blackboard.

### FR-7: Project Allowlist

SpecFlow dispatch MUST only run on projects with `specflow_enabled: true` in their blackboard project metadata. This is a configurable allowlist — projects must opt-in.

### FR-8: Shared Priority Queue

SpecFlow work items MUST share the same priority queue as GitHub issue work items. The `priority` field determines dispatch order. No separate scheduling.

### FR-9: Specify Phase Batch Mode

The specify phase MUST use `specflow specify --batch` mode. Decomposition data is pre-populated from:
- Feature description (from `specflow status` or `.specflow/features.db`)
- GitHub issue body (if triggered from a feature-request issue)

### FR-10: Observability

SpecFlow work items MUST be visible in:
- **Unified work item view:** Alongside GitHub items, with `source: 'specflow'` and phase metadata
- **Pipeline view:** A dedicated view showing per-feature phase progression (phase completed/in-progress/pending)
- **Events:** All phase transitions, quality gate results, retries, and worktree operations logged as blackboard events

### FR-11: Worktree Cleanup Evaluator

A periodic evaluator (run during heartbeat check) MUST:
- Scan `~/.pai/worktrees/*/specflow-*` for worktrees with no activity in `staleness_ttl` days
- Remove stale worktrees using `git worktree remove`
- Log cleanup events to the blackboard

## Non-Functional Requirements

### NFR-1: Concurrency

Only one SpecFlow feature processes at a time per project. SpecFlow work items share the global `maxConcurrent` limit with GitHub items. No parallel feature processing within a single project.

### NFR-2: Performance

- Phase transitions (creating next work item) MUST complete in < 1 second
- Worktree staleness check MUST complete in < 5 seconds
- No phase should block indefinitely — all specflow CLI calls use the existing timeout mechanism

### NFR-3: Reliability

- If the dispatch worker crashes mid-phase, the worktree persists and the work item can be re-queued
- SpecFlow's own `.specflow/features.db` tracks phase state, providing a secondary source of truth
- Orphaned worktrees are cleaned up by the staleness evaluator

### NFR-4: Security

- SpecFlow CLI is invoked as a subprocess, inheriting the dispatch worker's permissions
- No new network access patterns — specflow CLI uses the same `claude` binary
- Content filtering applies to any external inputs (feature-request issue bodies)

## Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| End-to-end pipeline works | A SpecFlow feature goes through all 5 phases autonomously and produces a PR |
| Unit tests pass | New tests for specflow dispatch logic, worktree persistence, work item chaining |
| Dashboard shows phases | Web dashboard displays SpecFlow feature pipeline progression |
| Manual trigger works | User can queue a SpecFlow feature via CLI and watch it progress through phases |
| Quality gates enforced | Failed quality gates trigger retries with feedback context |
| Shared queue works | SpecFlow and GitHub items dispatch in priority order from the same queue |

## Assumptions

- The `specflow` CLI binary is available at `~/bin/specflow` on the system where ivy-heartbeat runs
- Projects that opt-in to SpecFlow dispatch have a valid `.specflow/features.db` and `.specify/` directory
- The `specflow specify --batch` mode can produce adequate specs from feature descriptions without interactive interviews
- SpecFlow quality gates (80% threshold) are sufficient to prevent low-quality artifacts from progressing

## Out of Scope

- **Parallel SpecFlow features** — one feature at a time per project is sufficient for initial implementation
- **Cross-project SpecFlow** — features that span multiple repositories
- **Interactive specify mode** — batch mode only; interactive interviews require manual Claude Code sessions
- **SpecFlow dependency tracking** — feature dependencies within SpecFlow are not considered for dispatch ordering
