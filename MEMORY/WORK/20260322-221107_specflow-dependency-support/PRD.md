---
task: specflow orchestrator feature dependency support
slug: 20260322-221107_specflow-dependency-support
effort: advanced
phase: complete
progress: 30/30
mode: interactive
started: 2026-03-22T22:11:07Z
updated: 2026-03-22T22:15:00Z
---

## Context

Add feature-to-feature dependency support to the SpecFlow orchestrator and a new `specflow-bundle` CLI command. Extends the `depends_on` pattern from ivy-blackboard PR #46 (work item dependencies) to the specflow features layer. Supports both same-project and cross-project (`projectId:featureId`) dependencies. The orchestrator auto-unblocks downstream features when upstream completes.

**What was requested:** Feature-to-feature dependencies in orchestrator, `specflow-bundle` command for multi-feature projects with dependencies declared upfront, cross-project dependency support.

**Not requested:** Changes to work item depends_on, manual unblocking flows, breaking existing behavior.

### Risks
- Migration v9 on a live DB — additive (ALTER TABLE ADD COLUMN), safe
- Cross-project lookup requires both projects' features to be in the same blackboard DB (currently all features are in one global DB)
- Cycle detection must run at registration time, not at orchestration time
- `determineAction()` is a pure function — must keep it pure by passing deps as param

## Criteria

### Schema / DB (ivy-blackboard)
- [x] ISC-1: `specflow_features.depends_on TEXT` column added in schema CREATE_TABLES_SQL
- [ ] ISC-2: Migration v9 SQL adds column to existing databases via ALTER TABLE
- [ ] ISC-3: `CURRENT_SCHEMA_VERSION` bumped to 9
- [ ] ISC-4: Migration v9 registered in `migrate()` function in db.ts
- [ ] ISC-5: `SEED_VERSION_SQL` includes v9 entry

### Types (ivy-blackboard)
- [ ] ISC-6: `SpecFlowFeature.depends_on: string | null` in types.ts
- [ ] ISC-7: `CreateFeatureInput.dependsOn?: string` field added

### specflow-features.ts functions (ivy-blackboard)
- [ ] ISC-8: `createFeature()` stores `depends_on` from input; initial status is `blocked` when deps not all completed
- [ ] ISC-9: `depends_on` added to the `allowed` list in `updateFeature()`
- [ ] ISC-10: `upsertFeature()` passes through `dependsOn` on create path
- [ ] ISC-11: `checkFeatureDependenciesComplete(db, featureId)` returns true iff all dep features are `phase=completed`
- [ ] ISC-12: `checkFeatureDependenciesComplete()` handles cross-project format `projectId:featureId` (looks up by feature_id only)
- [ ] ISC-13: `unblockDependentFeatures(db, completedFeatureId)` finds all blocked features depending on the completed one
- [ ] ISC-14: `unblockDependentFeatures()` only unblocks if ALL dependencies of each candidate are now completed
- [ ] ISC-15: `unblockDependentFeatures()` returns count of features unblocked

### Blackboard facade (ivy-heartbeat)
- [ ] ISC-16: `bb.checkFeatureDependenciesComplete(featureId)` exposed in Blackboard class
- [ ] ISC-17: `bb.unblockDependentFeatures(completedFeatureId)` exposed in Blackboard class

### Orchestrator (ivy-heartbeat)
- [ ] ISC-18: `determineAction()` returns `wait` for features with unmet dependencies (passed as parameter)
- [ ] ISC-19: Orchestrator drain loop calls `unblockDependentFeatures` when feature transitions to `completed` phase
- [ ] ISC-20: Unblocked features are logged as an event on the blackboard

### specflow-queue CLI (ivy-heartbeat)
- [ ] ISC-21: `--depends-on <ids>` option added to `specflow-queue` command (comma-separated)
- [ ] ISC-22: Feature created with `blocked` status when `--depends-on` specifies unmet dependencies

### specflow-bundle CLI (ivy-heartbeat) — NEW
- [ ] ISC-23: `specflow-bundle` command registers with `ivy-heartbeat specflow-bundle`
- [ ] ISC-24: `--file <path>` option accepts a JSON bundle manifest
- [ ] ISC-25: Bundle JSON format: `{ project, features: [{ id, title, description?, dependsOn?, priority? }] }`
- [ ] ISC-26: Cross-project feature format `projectId:featureId` accepted in `dependsOn` field
- [ ] ISC-27: Cycle detection rejects bundles with circular dependencies before registration
- [ ] ISC-28: Features are registered in topological order (dependencies first)
- [ ] ISC-29: Dry-run `--dry-run` flag shows what would be registered without creating anything
- [ ] ISC-30: `specflow-bundle` registered in cli.ts

## Decisions

## Verification

- ivy-blackboard: 466 tests pass (14 new dependency tests added)
- ivy-heartbeat: 597 tests pass (5 new orchestrator dependency tests added)
- `specflow-bundle --help` confirmed registered and working
- `specflow-queue --help` shows `--depends-on` option
- simplify review completed: 5 issues fixed (duplicate parseDependencyId, N+1 batch query, LIKE pre-filter, extra getFeature read eliminated, duplicate PHASE_TIMEOUT_MAP removed)
