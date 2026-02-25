# F-026: Pipeline Visibility Dashboard

## Summary

This feature adds a comprehensive pipeline visibility dashboard to Ivy Heartbeat that shows the complete journey of SpecFlow features through all 8 phases (specify → plan → tasks → implement → complete → review → merge → reflect). The dashboard correlates data from the specflow features database and blackboard work items database to provide at-a-glance visibility into which features are in which phase, which PRs belong to which features, what was delivered, and what failed.

## What Changed

### New Files

- **`src/serve/api/pipeline-types.ts`** (86 lines): TypeScript interfaces for the pipeline data model
  - `FeaturePipeline` interface with all feature pipeline metadata
  - `PhaseStatus`, `PRMetadata`, `ReviewMetadata`, `PipelineTiming` types
  - `ALL_PIPELINE_PHASES` constant defining the 8-phase pipeline

- **`src/serve/api/pipeline-features.ts`** (240 lines): Core pipeline API implementation
  - `readSpecFlowFeatures()` — Reads feature definitions from specflow's features.db
  - `getFeaturePipelines()` — Correlates specflow features with blackboard work items
  - Extracts PR metadata, review status, rework cycles, and timing information
  - Groups features by project and computes pipeline outcome

### Modified Files

- **`CHANGELOG.md`**: Added F-026 entry to unreleased changes

### Spec Files (Generated)

- `.specify/specs/f-026-pipeline-visibility-dashboard/spec.md` (141 lines)
- `.specify/specs/f-026-pipeline-visibility-dashboard/plan.md` (91 lines)
- `.specify/specs/f-026-pipeline-visibility-dashboard/tasks.md` (133 lines)

## Architecture

### Data Sources

The pipeline API joins two separate SQLite databases:

1. **Specflow features.db** (`.specflow/features.db` in each project)
   - Feature definitions: id, name, phase, status, spec_path

2. **Blackboard local.db** (`~/.pai/blackboard/local.db`)
   - Work items with `specflow_feature_id` and `specflow_phase` in metadata
   - Review/merge/rework work items with PR correlation
   - Active agent sessions

### Key Design Decisions

- **No SQL JOIN**: Since the databases are separate, correlation happens in TypeScript
- **PR Correlation**: Features link to PRs via the `complete` phase work item metadata
- **Full Phase Tracking**: Extended from 5 phases to 8 phases (added review, merge, reflect)
- **Rework Tracking**: Counted as cycles, not a separate pipeline phase
- **Graceful Fallback**: Works even if specflow features.db doesn't exist for a project

## Configuration

No configuration changes required. The feature works with existing:
- Specflow features database at `.specflow/features.db`
- Blackboard database at `~/.pai/blackboard/local.db`

## Usage

### API Endpoints

#### Get Feature Pipelines
```bash
# All projects
curl http://localhost:8888/api/pipeline/features

# Filter by project
curl http://localhost:8888/api/pipeline/features?project=ivy-heartbeat
```

Returns an array of `FeaturePipeline` objects with:
- Feature ID, name, and project
- Phase status for all 8 phases
- Current phase and outcome (delivered/in_progress/failed/available)
- PR metadata (number, URL, state)
- Review metadata (status, rework cycles)
- Timing information (started, last activity, duration)
- Active agent session ID if applicable

#### Example Response
```json
{
  "feature_id": "F-026",
  "feature_name": "Pipeline visibility dashboard",
  "project": "ivy-heartbeat",
  "phases": [
    { "phase": "specify", "status": "completed" },
    { "phase": "plan", "status": "completed" },
    { "phase": "tasks", "status": "completed" },
    { "phase": "implement", "status": "in_progress" },
    { "phase": "complete", "status": "pending" },
    { "phase": "review", "status": "pending" },
    { "phase": "merge", "status": "pending" },
    { "phase": "reflect", "status": "pending" }
  ],
  "current_phase": "implement",
  "outcome": "in_progress",
  "timing": {
    "started": "2026-02-25T20:00:00Z",
    "last_activity": "2026-02-25T21:30:00Z",
    "duration_minutes": 90
  },
  "active_agent": "session-abc123"
}
```

## Next Steps

The implementation is complete for Phase 1 (Pipeline Features API). Remaining phases:
- **Phase 2**: Pipeline Summary API (`src/serve/api/pipeline-summary.ts`)
- **Phase 3**: Dashboard HTML rewrite (`src/serve/dashboard.ts`)
- **Phase 4**: Server route wiring (`src/serve/server.ts`)
- **Phase 5**: Tests

See `plan.md` and `tasks.md` for full implementation breakdown.
