# Implementation Tasks: F-026 Pipeline Visibility Dashboard

## Phase 1: Pipeline Features API

### T-1.1: Define FeaturePipeline types
- Create `src/serve/api/pipeline-types.ts`
- Define `FeaturePipeline`, `PhaseStatus`, `PipelineSummary` interfaces
- Define `ALL_PIPELINE_PHASES` constant: `['specify', 'plan', 'tasks', 'implement', 'complete', 'review', 'merge', 'reflect']`
- Effort: Small

### T-1.2: Implement specflow DB reader
- In `pipeline-features.ts`, add `readSpecFlowFeatures(dbPath: string)` function
- Opens specflow `features.db` via `bun:sqlite` (read-only)
- Returns array of `{ id, name, phase, status, spec_path }`
- Graceful fallback if DB doesn't exist
- Effort: Small

### T-1.3: Implement feature-to-PR correlation
- Query blackboard work items with `specflow_feature_id` in metadata
- For each feature, find the `complete` phase work item to get `pr_number`
- Then find review/merge/rework items by PR number pattern (`review-{repo}-pr-{N}`, `merge-{repo}-pr-{N}`, `rework-{repo}-pr-{N}`)
- Extract: review status, rework cycle count, merge status
- Effort: Medium

### T-1.4: Build unified getFeaturePipelines() function
- Combine specflow DB features + blackboard work items + PR correlation
- Group by project (from `specflow_project_id` metadata)
- Compute outcome: `delivered` (merge completed), `in_progress` (active phase), `failed`, `available`
- Compute timing: started (earliest work item), last_activity, duration
- Detect active agents per feature
- Support `project` filter parameter
- Effort: Medium

## Phase 2: Pipeline Summary API

### T-2.1: Implement getPipelineSummary()
- Create `src/serve/api/pipeline-summary.ts`
- Count: total features, delivered, in_flight, failed, active agents
- Per-project breakdown
- Takes pre-computed `FeaturePipeline[]` as input (no duplicate DB queries)
- Effort: Small

## Phase 3: Dashboard HTML

### T-3.1: Summary stat cards
- Top row with 5 stat cards: Delivered, In PR, Active, Agents, Failed
- Each card: big number + label + color (green/blue/amber/gray/red)
- Effort: Small

### T-3.2: Feature pipeline cards
- Project-grouped sections with header: "ivy-heartbeat (12 delivered, 2 in flight)"
- Each feature row: feature ID, name, phase dots, PR link, outcome badge, timing
- Phase dots: colored circles with arrows between, using the full 8-phase pipeline
- Colors: green=completed, blue=in_progress, gray=pending, red=failed
- Outcome badges: MERGED (green), IN REVIEW (blue), REWORK (amber), AVAILABLE (gray), FAILED (red)
- PR link: clickable "PR #N" linking to GitHub URL
- Timing: "Started 2h ago · Merged 5m ago" or "3h 45m total · 1 rework cycle"
- Effort: Medium

### T-3.3: Active agents panel
- Section below features showing currently active agents
- Columns: name, feature/work item, elapsed time, PID
- Empty state: "No active agents"
- Effort: Small

### T-3.4: Significant events feed
- Filter events to: phase transitions (work_completed, work_claimed), errors, PR events
- Exclude: heartbeats, routine dispatches, agent registration
- Show feature ID and project inline
- Limit to 20 most recent significant events
- Effort: Small

### T-3.5: Project filter and auto-refresh
- Dropdown at top: "All Projects", "ivy-heartbeat", "ragent", "supertag-cli"
- JavaScript filtering (client-side, no server roundtrip)
- Auto-refresh every 30 seconds
- Manual refresh button
- Effort: Small

## Phase 4: Server Wiring

### T-4.1: Add API routes and connect data sources
- Add `GET /api/pipeline/features` route → `getFeaturePipelines()`
- Add `GET /api/pipeline/summary` route → `getPipelineSummary()`
- Pass specflow DB path (resolve from project working directory)
- Pass blackboard instance
- Keep existing `/api/events`, `/api/heartbeats`, `/api/summary`, `/api/search` routes unchanged
- Remove `/api/specflow/pipelines` and `/api/specflow/panel` (replaced)
- Effort: Small

## Phase 5: Tests

### T-5.1: Pipeline features API tests
- Test specflow DB reader with in-memory DB fixture
- Test feature-to-PR correlation with mock work items
- Test phase status computation
- Test project filtering
- Test graceful fallback when specflow DB missing
- Effort: Medium

### T-5.2: Pipeline summary tests
- Test aggregate counts
- Test per-project breakdown
- Effort: Small

### T-5.3: Server route tests
- Test `/api/pipeline/features` returns valid JSON
- Test `/api/pipeline/summary` returns valid JSON
- Test project filter parameter
- Effort: Small

## Dependency Graph

```
T-1.1 (types) ──→ T-1.2 (specflow reader) ──→ T-1.4 (unified function)
                   T-1.3 (PR correlation)  ──→ T-1.4
T-1.4 ──→ T-2.1 (summary)
T-1.4 ──→ T-3.1, T-3.2, T-3.3, T-3.4, T-3.5 (all dashboard tasks)
T-1.4 + T-2.1 ──→ T-4.1 (server wiring)
T-1.4 + T-4.1 ──→ T-5.1, T-5.2, T-5.3 (tests)
```

## Parallelizable
- T-3.1 through T-3.5 can be built in parallel once T-1.4 is done
- T-5.1 and T-5.2 can run in parallel
- T-1.2 and T-1.3 can be built in parallel

## Total: 14 tasks across 5 phases
- Phase 1: 4 tasks (types, DB reader, PR correlation, unified function)
- Phase 2: 1 task (summary)
- Phase 3: 5 tasks (stat cards, feature cards, agents panel, events feed, filter)
- Phase 4: 1 task (server wiring)
- Phase 5: 3 tasks (features tests, summary tests, route tests)
