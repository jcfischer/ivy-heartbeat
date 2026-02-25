# F-026: Pipeline Visibility Dashboard

## Overview

The current Ivy Heartbeat dashboard (`src/serve/dashboard.ts`) shows raw events, heartbeats, and search — but provides no visibility into what matters: which features are in which phase, which PRs belong to which features, what was delivered, and what failed. The operator has to manually query blackboard CLI, specflow status, and GitHub to piece together the pipeline state. This feature replaces the dashboard with a pipeline board that joins specflow features DB and blackboard work items into an at-a-glance view.

## Problem Statement

The dispatch pipeline processes features through 8+ phases (specify → plan → tasks → implement → complete → review → rework* → merge → reflect), across multiple projects (ivy-heartbeat, ragent, supertag-cli). The current dashboard shows none of this:

- **No feature pipeline view** — the specflow panel API exists but isn't wired into the dashboard
- **Only 5 phases tracked** — misses review, rework, merge, reflect
- **No PR links** — can't see which PR belongs to which feature
- **No project grouping** — flat event stream
- **No outcome tracking** — was review approved? How many rework cycles?
- **No "delivered" view** — what merged vs what's in flight
- **No failure visibility** — which features failed and why

**Impact:** The operator loses track of pipeline state, discovers problems only when they cascade (spec-only PRs merged, false review approvals, stuck work items), and cannot answer basic questions: "What got delivered today? What's blocked?"

## Users & Stakeholders

- **Primary user:** PAI operator (Jens-Christian) monitoring the dispatch pipeline
- **Consumer:** Any session reviewing pipeline health

## User Scenarios

### Scenario 1: At-a-Glance Pipeline Status
**Given:** Multiple features are in various phases across 3 projects
**When:** The operator opens the dashboard
**Then:** Features are grouped by project with summary counts (delivered, in-flight, failed)
**And:** Each feature shows its phase progression as colored dots with the current phase highlighted
**And:** PR number, URL, and state (open/merged/closed) are shown inline

### Scenario 2: Understanding What Was Delivered
**Given:** Several features have completed the full pipeline and been merged
**When:** The operator looks at a project group
**Then:** Delivered features show "MERGED" badge with the PR link and total pipeline duration
**And:** Rework cycles are shown (e.g., "1 rework cycle")

### Scenario 3: Identifying Stuck or Failed Features
**Given:** A feature's implement phase failed or a review requested changes
**When:** The operator scans the dashboard
**Then:** Failed/stuck features are visually distinct (red/amber indicators)
**And:** The most recent error or status is shown inline
**And:** Active agents working on features are visible

### Scenario 4: Filtering by Project
**Given:** The operator wants to focus on ivy-heartbeat features only
**When:** They select ivy-heartbeat from the project filter
**Then:** Only ivy-heartbeat features are shown
**And:** Summary counts update to reflect the filter

## Functional Requirements

### FR-1: Pipeline Feature API
- New endpoint `GET /api/pipeline/features` returning joined feature data
- Joins specflow features DB (feature definitions, phases) with blackboard work items DB (work item status, metadata with PR info, review outcomes)
- Groups by project, derived from work item metadata `specflow_project_id` or specflow DB
- Tracks all phases: specify, plan, tasks, implement, complete, review, rework (×N), merge, reflect
- Includes PR number, PR URL, PR state from work item metadata
- Includes rework cycle count and review outcome
- Supports `?project=` filter parameter

### FR-2: Pipeline Summary API
- New endpoint `GET /api/pipeline/summary` with aggregate counts
- Counts: total features, delivered (merged), in-flight (active phase), failed, active agents
- Per-project breakdown

### FR-3: Dashboard HTML — Feature Pipeline Board
- Replace current events-only dashboard with pipeline board layout
- Summary stat cards at top (delivered, in PR, active, agents, failed)
- Features grouped by project with project header showing counts
- Each feature card shows: feature ID, name, phase dots (full pipeline), current phase, PR link, outcome badge, timing
- Phase dots: green (completed), blue (in progress), gray (pending), red (failed)
- Outcome badges: MERGED, IN REVIEW, REWORK, AVAILABLE, FAILED
- Auto-refresh every 30 seconds

### FR-4: Active Agents Panel
- Show currently active agents with: name, feature being worked, elapsed time
- Replaces the raw heartbeat table

### FR-5: Significant Events Feed
- Filter events to show only phase transitions, errors, and completions
- Not raw heartbeats or routine dispatches
- Show feature ID inline with each event

## Non-Functional Requirements

- Dashboard must load in < 500ms (all data from local SQLite)
- No external dependencies — inline CSS and vanilla JS only (existing pattern)
- Mobile-friendly (responsive layout)
- Backward compatible — existing API endpoints remain unchanged

## Technical Constraints

- Specflow features DB is at `.specflow/features.db` in each project
- For cross-project view, need to locate features DBs for all registered projects
- Blackboard DB is at `~/.pai/blackboard/local.db`
- Dashboard is server-rendered HTML template (TypeScript template literal)
- Work item metadata is JSON string in `metadata` column

## Data Model

### FeaturePipeline (API response type)
```typescript
interface FeaturePipeline {
  feature_id: string;         // F-026
  feature_name: string;       // Pipeline visibility dashboard
  project: string;            // ivy-heartbeat
  phases: PhaseStatus[];      // All phases with status
  current_phase: string;      // implement
  outcome: 'delivered' | 'in_progress' | 'failed' | 'available';
  pr?: {
    number: number;
    url: string;
    state: 'open' | 'merged' | 'closed';
  };
  review?: {
    status: 'approved' | 'changes_requested' | null;
    rework_cycles: number;
  };
  timing: {
    started: string;          // ISO timestamp
    last_activity: string;
    duration_minutes: number;
  };
  active_agent?: string;      // Session ID if agent is working on it
}

interface PhaseStatus {
  phase: string;
  status: 'completed' | 'in_progress' | 'pending' | 'failed' | 'skipped';
}
```

## Out of Scope
- Real-time WebSocket updates (polling at 30s is sufficient)
- GitHub API calls for live PR status (use cached metadata from work items)
- Log viewer per feature (future enhancement)
- Editing features from the dashboard
