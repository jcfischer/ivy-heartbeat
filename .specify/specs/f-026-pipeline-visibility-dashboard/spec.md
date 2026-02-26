# F-026: SpecFlow Pipeline Visibility Dashboard

## Overview

The SpecFlow pipeline runs features through an 11-phase state machine managed by the F-027 orchestrator. Each feature's full lifecycle state — phase, eval scores, failure count, PR link, GitHub issue — is stored in the `specflow_features` table in ivy-blackboard. This feature replaces the old work-item-correlation approach with a direct, accurate dashboard panel that reads from the single source of truth.

**Note:** This spec was rewritten after F-027 (state machine redesign) was implemented. The original F-026 spec (PR #35) described correlating work items to infer pipeline state — that approach is obsolete. F-027 provides `bb.listFeatures()` and three REST endpoints that make this trivial.

**Repos affected:** `ivy-heartbeat` (serve layer only — API routes, HTML panel, dashboard)

---

## Problem Statement

The existing dashboard at `localhost:7878` has no SpecFlow pipeline section. PR #35 (closed) added a partial implementation that:

- Parsed all work items and grouped by `specflow_feature_id` from metadata JSON
- Showed 5 phases (specify/plan/tasks/implement/complete) with basic pass/fail/active status
- Had no eval scores, failure counts, PR links, or event timeline

With F-027 active, the `specflow_features` table is the authoritative source. The current partial implementation (`specflow-pipeline.ts`) still uses the old correlation approach despite the better data being available. The panel shows stale work-item state instead of the live state machine.

### What's missing from the dashboard

1. **No SpecFlow section at all** — `dashboard.ts` has no SpecFlow tab or section
2. **Correlation code is now dead weight** — `specflow-pipeline.ts` groups work items manually; `bb.listFeatures()` replaces this with one call
3. **5 phases shown** — state machine has 11 phases with distinct active/succeeded distinction
4. **No eval scores** — `specify_score`, `plan_score`, `implement_score` exist but aren't shown
5. **No failure visibility** — `failure_count` / `max_failures` not surfaced; users can't see if a feature is stuck
6. **No PR link** — `pr_url` / `pr_number` available but not shown
7. **No event timeline** — `GET /api/specflow/features/:id/events` is wired but never called from the UI

---

## Users & Stakeholders

- **PAI operator (Jens-Christian)** — wants to see at a glance which features are in-flight, stuck, or complete
- **Post-mortem analysis** — wants to see what happened when a feature fails (event timeline)

---

## User Scenarios

### Scenario 1: At-a-glance pipeline status

**Given:** 4 features are in various states — one implementing, one stuck (failure_count=2), one completed with PR #42, one specifying
**When:** Operator opens `localhost:7878`
**Then:** SpecFlow section shows all 4 features with:
- Current phase highlighted in the 11-phase track
- Failure badges for the stuck feature (2/3 shown in orange)
- PR link badge for the completed feature
- Time-in-phase indicator for the active feature

### Scenario 2: Stuck feature detection

**Given:** Feature F-111 has `failure_count=2`, `phase=implementing`, `status=failed`, `last_error="Code gate failed: no source changes"`
**When:** Operator views the dashboard
**Then:** Feature row shows failure badge "2/3" in red, `last_error` visible on hover/detail

### Scenario 3: Feature event timeline

**Given:** Feature F-023 has completed all phases
**When:** Operator clicks the feature row
**Then:** Event timeline expands showing all phase transitions with timestamps, eval scores, and error messages logged by the orchestrator

### Scenario 4: Phase score visibility

**Given:** Feature F-025 passed specifying with score 92, planning with score 85
**When:** Operator views the panel
**Then:** Completed phases show their eval score inline (e.g., "specified ✓ 92")

---

## Functional Requirements

### FR-1: Replace Work-Item Correlation with Direct Feature Query

**Requirement:** `src/serve/api/specflow-pipeline.ts` must be rewritten to call `bb.listFeatures()` instead of `bb.listWorkItems()` + JSON parsing.

**Old implementation (to remove):**
```typescript
// REMOVE: grouping work items by specflow_feature_id
const items = bb.listWorkItems({ all: true });
for (const item of items) {
  const meta = JSON.parse(item.metadata);
  if (!meta.specflow_feature_id) continue;
  // ... correlation logic
}
```

**New implementation:**
```typescript
export function getSpecFlowFeaturesView(bb: Blackboard): SpecFlowFeature[] {
  return bb.listFeatures();
}
```

The `SpecFlowFeature` type from `ivy-blackboard/src/types.ts` contains all needed fields. No additional transformation required.

### FR-2: 11-Phase State Machine Display

**Requirement:** `src/serve/views/specflow-panel.ts` must show the full 11-phase pipeline with visual distinction between completed, active, and pending phases.

**Phase sequence:**
```
queued → specifying → specified → planning → planned →
  tasking → tasked → implementing → implemented →
  completing → completed
```

**Visual spec:**
- Completed phases (`*ed`): green dot + phase name + eval score if available
- Active phase (`*ing`): blue pulsing dot + phase name + time elapsed
- Pending phases: gray dot + phase name
- Terminal failed: red badge replacing phase track
- Terminal blocked: orange badge

**Table columns:**
| Column | Content |
|--------|---------|
| Feature | `feature_id` (monospace, clickable) |
| Title | `title` (truncated to 40 chars) |
| Pipeline | Phase track (11 dots + labels) |
| Scores | `specify_score / plan_score / implement_score` (e.g., "92 / 85 / –") |
| Failures | `failure_count / max_failures` — hidden if 0, orange if ≥1, red if = max |
| PR | Link badge if `pr_url` set, else `–` |
| Updated | `updated_at` as relative time |

### FR-3: Dashboard HTML SpecFlow Section

**Requirement:** `src/serve/dashboard.ts` must include a "SpecFlow Pipeline" section that auto-fetches from `/api/specflow/panel` and refreshes every 30 seconds alongside the existing sections.

**Placement:** Between the Summary stats and the Events section (top of page, most actionable information first).

**Behavior:**
- Fetch on page load
- Refresh every 30 seconds (same interval as the rest of the dashboard)
- Show "No active SpecFlow features" when `listFeatures()` returns empty
- Click on feature ID opens detail (shows event timeline inline)

### FR-4: Feature Event Timeline (Click-to-Expand)

**Requirement:** Clicking a feature row in the panel fetches `/api/specflow/features/:id/events` and renders an inline timeline below the row.

**Event display:** Timestamp | Summary | Metadata highlights (phase transition, eval score, error message)

**Toggle behavior:** Click again to collapse. Only one feature expanded at a time.

### FR-5: Update `/api/specflow/panel` Route

**Requirement:** The `/api/specflow/panel` route in `server.ts` currently calls `getSpecFlowPipelines(bb)` (old correlation code). It must call `getSpecFlowFeaturesView(bb)` and use the updated `renderSpecFlowPanel()`.

**No new routes required** — `/api/specflow/features`, `/:id`, and `/:id/events` are already wired in `server.ts` (from F-027 Phase 2 implementation, T-2.5–T-2.7).

### FR-6: Cleanup Dead Code

**Requirement:** Remove the old `PipelineFeature` interface and correlation logic from `specflow-pipeline.ts`. The file becomes a thin adapter over `bb.listFeatures()`.

---

## Error Handling

### API Errors

| Error Scenario | User-Visible Behavior | Recovery |
|---|---|---|
| `/api/specflow/panel` returns 500 | "Unable to load pipeline data" message in panel area | Retry on next 30s refresh cycle |
| `/api/specflow/features/:id/events` returns 404 | Inline "No events found for this feature" | Collapse expander, no crash |
| Network timeout (> 5s) | Show stale data with "(stale)" indicator, soft error in console | Auto-retry on next refresh |
| `bb.listFeatures()` throws | Server logs error; panel endpoint returns `{ error: "..." }` JSON with 500 | Heartbeat continues unaffected |

### Edge Cases

- **Null fields:** `pr_url`, `last_error`, `specify_score`, `plan_score`, `implement_score` may be null — render as `—` or omit gracefully
- **Empty feature list:** Show "No active SpecFlow features" placeholder — not an error state
- **Very long `last_error`:** Truncate to 120 chars in tooltip; full text on expand
- **Invalid phase value:** Unknown phases render as gray with raw phase name — no crash
- **Concurrent refresh:** If user clicks expand during refresh, preserve expanded state

---

## Non-Functional Requirements

### NFR-1: No New Dependencies

Dashboard is inline CSS + vanilla JS. No frontend framework. No additional npm packages.

### NFR-2: Performance

`bb.listFeatures()` is a single indexed SQLite query — O(n features). Panel endpoint must respond in < 50ms for up to 50 active features.

### NFR-3: No Breaking Changes

The `/api/specflow/features` endpoint (clean JSON) remains unchanged. Only the `/api/specflow/panel` HTML response changes.

### NFR-4: Security

- Panel endpoint only accessible on `localhost:7878` (local-only dashboard — no public exposure)
- `last_error` and feature titles rendered via `textContent` (not `innerHTML`) — no XSS risk from agent-generated error strings
- No authentication required (localhost-only, same-machine operator assumed)

### NFR-5: Accessibility

- Phase badges use color + text labels (not color alone) to be colorblind-accessible
- Click targets (feature rows) minimum 44px height per touch target guidelines
- Keyboard navigation: Enter/Space opens event timeline for focused row

---

## Success Criteria

1. **Single source of truth** — Panel reads from `specflow_features` table, not work items
2. **All 11 phases visible** — Phase track shows full state machine, not 5-phase abbreviation
3. **Failure visibility** — Features with `failure_count > 0` show a visible badge
4. **Eval scores shown** — `specify_score`, `plan_score`, `implement_score` inline
5. **PR links clickable** — `pr_url` rendered as anchor when set
6. **Event timeline works** — Click-to-expand loads `/:id/events` and renders inline
7. **Dashboard refresh** — SpecFlow section auto-refreshes with the rest of the dashboard
8. **Dead code removed** — `specflow-pipeline.ts` no longer contains work-item correlation logic

---

## Out of Scope

- WebSocket push updates (polling is sufficient for 9-minute cycle time)
- Historical charts / metrics over time
- Admin actions from dashboard (pause, fail, reset feature)
- Mobile-optimized layout

---

## References

- F-027 spec: `.specify/specs/f-027-specflow-state-machine-redesign/spec.md`
- Current (stale) implementation: `src/serve/api/specflow-pipeline.ts`
- Blackboard features module: `~/work/ivy-blackboard/src/specflow-features.ts`
- Blackboard type: `SpecFlowFeature` in `ivy-blackboard/src/types.ts`
- Live API: `GET /api/specflow/features` (already returns `SpecFlowFeature[]`)
