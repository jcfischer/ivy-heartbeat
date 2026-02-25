# Technical Plan: F-026 Pipeline Visibility Dashboard

## Architecture

### Data Flow
```
specflow features.db ──┐
  (feature definitions) │
                        ├──→ pipeline-features.ts ──→ /api/pipeline/* ──→ dashboard.ts
blackboard local.db ───┘
  work_items (phases + review/merge/rework metadata)
  events (phase transitions, errors)
  agents (active sessions)
```

### Key Design Decision: Join Strategy

The specflow features DB and blackboard DB are separate SQLite databases. We cannot do a SQL JOIN across them. Instead:

1. Query specflow DB for feature definitions (id, name, phase, status, spec_path)
2. Query blackboard DB for all work items with `specflow_feature_id` or `specflow_project_id` in metadata
3. Also query review/merge/rework items (which carry `pr_number` + `repo` but not `specflow_feature_id`)
4. Correlate review/merge items to features via the `complete` phase work item (which has both feature_id and pr_number)
5. Build unified `FeaturePipeline[]` in TypeScript

### Key Design Decision: Multi-Project Support

The specflow features DB path varies per project. For the initial implementation:
- Read ivy-heartbeat's `.specflow/features.db` directly (known path)
- For other projects, blackboard work items carry `specflow_project_id` in metadata — group by this
- Feature name falls back to work item title if specflow DB is not available for that project

### Key Design Decision: Full Phase Tracking

Current `ALL_PHASES` is `['specify', 'plan', 'tasks', 'implement', 'complete']`. Extended to:
```typescript
const ALL_PHASES = ['specify', 'plan', 'tasks', 'implement', 'complete', 'review', 'merge', 'reflect'];
```
Rework is not a separate phase in the pipeline — it's tracked via `rework_cycles` count derived from rework work items.

## Implementation Phases

### Phase 1: Pipeline Features API (`src/serve/api/pipeline-features.ts`)
- Rewrite `getSpecFlowPipelines()` with the extended data model
- Add specflow DB reader (query features table directly via `bun:sqlite`)
- Add correlation logic: feature → complete work item → PR number → review/merge items
- Add `getSpecFlowDb()` helper that opens the features DB
- New `FeaturePipeline` type with all fields from spec
- Support `?project=` query parameter filtering

### Phase 2: Pipeline Summary API (`src/serve/api/pipeline-summary.ts`)
- New `getPipelineSummary()` function
- Aggregate: total, delivered, in_flight, failed, agents_active
- Per-project breakdown

### Phase 3: Dashboard HTML (`src/serve/dashboard.ts`)
- Replace `generateDashboardHTML()` with new pipeline board layout
- Summary stat cards at top
- Project-grouped feature cards with phase dots
- PR links, outcome badges, timing
- Active agents panel
- Significant events feed (filtered)
- Project filter dropdown
- Auto-refresh at 30s

### Phase 4: Server Wiring (`src/serve/server.ts`)
- Add routes: `/api/pipeline/features`, `/api/pipeline/summary`
- Pass specflow DB path to pipeline API
- Keep existing routes for backward compatibility

### Phase 5: Tests
- Unit tests for pipeline-features.ts (data joining, phase tracking, PR correlation)
- Unit tests for pipeline-summary.ts (aggregation)
- Server route tests (API responses)

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `src/serve/api/pipeline-features.ts` | Rewrite | Full pipeline feature data with joins |
| `src/serve/api/pipeline-summary.ts` | Create | Aggregate summary endpoint |
| `src/serve/dashboard.ts` | Rewrite | New pipeline board HTML |
| `src/serve/views/specflow-panel.ts` | Delete | Replaced by dashboard.ts pipeline view |
| `src/serve/server.ts` | Modify | Add new API routes |
| `tests/pipeline-features.test.ts` | Create | Pipeline API tests |
| `tests/pipeline-summary.test.ts` | Create | Summary API tests |

## Dependencies
- `bun:sqlite` for reading specflow features DB
- Existing blackboard API (listWorkItems, eventQueries, agentQueries)
- No new external dependencies
