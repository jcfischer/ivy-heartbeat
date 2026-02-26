# Technical Plan: F-026 Pipeline Visibility Dashboard

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Browser (localhost:7878)                                    │
│  dashboard.ts — inline JS fetches /api/specflow/panel        │
│  every 30s + click → /api/specflow/features/:id/events      │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP
┌────────────────────▼────────────────────────────────────────┐
│  server.ts                                                   │
│  GET /api/specflow/panel       → renderSpecFlowPanel()       │
│  GET /api/specflow/features    → bb.listFeatures()  (exist.) │
│  GET /api/specflow/features/:id/events  (existing)           │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  src/serve/api/specflow-pipeline.ts (rewritten)              │
│  getSpecFlowFeaturesView(bb) → bb.listFeatures()             │
│                                                              │
│  src/serve/views/specflow-panel.ts (rewritten)               │
│  renderSpecFlowPanel(features: SpecFlowFeature[]) → HTML     │
└────────────────────┬────────────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────────────┐
│  ivy-blackboard  (no changes)                                │
│  bb.listFeatures()  → specflow_features table (SQLite)       │
│  bb.eventQueries.search(featureId) → events table            │
└─────────────────────────────────────────────────────────────┘
```

**Change surface:** 3 existing files modified, 0 new files created.

---

## Requirement Mapping

| Spec Requirement | Implementation Approach | Files Changed |
|---|---|---|
| FR-1: Replace work-item correlation with `bb.listFeatures()` | Remove `PipelineFeature` interface and all grouping logic; replace with `getSpecFlowFeaturesView(bb)` thin adapter | `src/serve/api/specflow-pipeline.ts` |
| FR-2: 11-phase state machine display | `DISPLAY_PHASES` array + `phaseState()` function driving per-dot CSS classes (`completed/active/pending`) | `src/serve/views/specflow-panel.ts` |
| FR-3: Dashboard auto-fetch with 30s refresh | `loadSpecFlow()` in `dashboard.ts` inline script; called from existing `refresh()` function | `src/serve/dashboard.ts` |
| FR-4: Click-to-expand event timeline | IIFE-scoped inline JS in panel fragment; `fetch('/api/specflow/features/{id}/events')` on row click | `src/serve/views/specflow-panel.ts` |
| FR-5: Update `/api/specflow/panel` route | Swap `getSpecFlowPipelines` → `getSpecFlowFeaturesView`; remove dead `/api/specflow/pipelines` route | `src/serve/server.ts` |
| FR-6: Remove dead correlation code | Delete `PipelineFeature`, `ALL_PHASES`, `getSpecFlowPipelines` entirely | `src/serve/api/specflow-pipeline.ts` |
| NFR-1: No new dependencies | Vanilla JS + inline CSS only; `SpecFlowFeature` type already imported in `server.ts` | No `package.json` changes |
| NFR-2: < 50ms for 50 features | Single `bb.listFeatures()` SQLite query; HTML generation is O(n) string concatenation | No changes needed |
| NFR-4: XSS safety | `escapeHtml()` for all feature data; `textContent` not `innerHTML` for dynamic inserts; `https://` validation for `pr_url` | `src/serve/views/specflow-panel.ts` |

---

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Project standard (CLAUDE.md) |
| Database | ivy-blackboard SQLite (existing) | `specflow_features` is the authoritative source per F-027 |
| Frontend | Inline CSS + vanilla JS | NFR-1: no new dependencies, matches dashboard.ts pattern |
| Types | `SpecFlowFeature` from ivy-blackboard | Already imported; no new type definitions needed |

---

## Data Model

No schema changes. All data flows from the existing `specflow_features` table via `bb.listFeatures()`.

```typescript
// From ivy-blackboard/src/types.ts — used as-is, no transformation
interface SpecFlowFeature {
  feature_id: string;
  project_id: string;
  title: string;
  description: string | null;
  phase: SpecFlowFeaturePhase;    // 11-value union
  status: SpecFlowFeatureStatus;  // pending | active | succeeded | failed | blocked
  failure_count: number;
  max_failures: number;
  last_error: string | null;
  specify_score: number | null;
  plan_score: number | null;
  implement_score: number | null;
  pr_number: number | null;
  pr_url: string | null;
  phase_started_at: string | null;  // for time-in-phase
  updated_at: string;
}
```

**Phase sequence** (11 phases + 2 terminal states):
```
queued → specifying → specified → planning → planned →
  tasking → tasked → implementing → implemented →
  completing → completed
                                        ↓ (terminal)
                                  failed | blocked
```

**Phase classification logic:**
- `*ed` phases (specified, planned, tasked, implemented, completed, queued) → completed dot (green)
- `*ing` phases (specifying, planning, tasking, implementing, completing) → active dot (blue pulse)
- `failed` / `blocked` status → replace track with terminal badge

---

## API Contracts

### Unchanged endpoints (already wired in server.ts)

```
GET /api/specflow/features
GET /api/specflow/features/:id
GET /api/specflow/features/:id/events
```

### Modified endpoint

```
GET /api/specflow/panel
  → was: getSpecFlowPipelines(bb) → renderSpecFlowPanel(PipelineFeature[])
  → now: bb.listFeatures()        → renderSpecFlowPanel(SpecFlowFeature[])

Response: text/html fragment (no shape change for the route)
```

---

## Implementation Phases

### Phase 1 — Rewrite `specflow-pipeline.ts` (data layer)

**File:** `src/serve/api/specflow-pipeline.ts`

**Changes:**
- Remove `PipelineFeature` interface and `ALL_PHASES` constant
- Remove `getSpecFlowPipelines()` (entire correlation body)
- Add thin adapter:

```typescript
import type { Blackboard } from '../../blackboard.ts';
import type { SpecFlowFeature } from 'ivy-blackboard/src/types.ts';

export type { SpecFlowFeature };

export function getSpecFlowFeaturesView(bb: Blackboard): SpecFlowFeature[] {
  return bb.listFeatures();
}
```

**Risk:** Import path for `SpecFlowFeature` — verify exact path used elsewhere in the project (likely re-exported from `../../blackboard.ts`).

---

### Phase 2 — Rewrite `specflow-panel.ts` (view layer)

**File:** `src/serve/views/specflow-panel.ts`

**Full rewrite to:**
1. Accept `SpecFlowFeature[]` instead of `PipelineFeature[]`
2. Render 11-phase track with visual dot states
3. Add Scores, Failures, PR columns
4. Add click-to-expand event timeline (JS in the fragment)
5. Use `textContent` assignment via data attributes — no raw HTML injection from feature data

**Phase track rendering:**

```typescript
const ACTIVE_PHASES = new Set(['specifying','planning','tasking','implementing','completing']);
const DISPLAY_PHASES = ['queued','specifying','specified','planning','planned',
  'tasking','tasked','implementing','implemented','completing','completed'];

function phaseState(feature: SpecFlowFeature, phase: string): 'completed'|'active'|'pending' {
  const idx = DISPLAY_PHASES.indexOf(phase);
  const cur = DISPLAY_PHASES.indexOf(feature.phase);
  if (idx < cur) return 'completed';
  if (idx === cur && ACTIVE_PHASES.has(phase)) return 'active';
  if (idx === cur) return 'completed'; // terminal *ed states
  return 'pending';
}
```

**Table columns:**
| Column | Source field |
|--------|-------------|
| Feature | `feature_id` (monospace) — clickable to expand |
| Title | `title.slice(0,40)` |
| Pipeline | 11-dot phase track (or terminal badge) |
| Scores | `specify_score / plan_score / implement_score` → `"92 / 85 / –"` |
| Failures | `failure_count/max_failures` — hidden if 0, orange if ≥1, red if = max |
| PR | `<a href={pr_url}>#pr_number</a>` or `–` |
| Updated | `relTimeAgo(updated_at)` |

**Event timeline (inline JS in the HTML fragment):**
- On feature row click: fetch `/api/specflow/features/{id}/events`, render timestamp + summary table in a `<tr class="timeline-row">` below
- Second click: remove the timeline row (toggle)
- `currentExpanded` variable prevents multiple open rows

**XSS safety:** All user-data strings inserted via `element.textContent` or pre-escaped with `escapeHtml()`. PR URL validated to start with `https://` before rendering as `<a href>`.

---

### Phase 3 — Update `server.ts` (route wiring)

**File:** `src/serve/server.ts`

**Changes:**
1. Replace import: `getSpecFlowPipelines` → `getSpecFlowFeaturesView`
2. Update `/api/specflow/panel` handler:

```typescript
// Before:
import { getSpecFlowPipelines } from './api/specflow-pipeline.ts';
// ...
const pipelines = getSpecFlowPipelines(bb);
const html = renderSpecFlowPanel(pipelines);

// After:
import { getSpecFlowFeaturesView } from './api/specflow-pipeline.ts';
// ...
const features = getSpecFlowFeaturesView(bb);
const html = renderSpecFlowPanel(features);
```

3. Remove now-unused `/api/specflow/pipelines` route (was calling old `getSpecFlowPipelines`).

---

### Phase 4 — Add SpecFlow section to `dashboard.ts`

**File:** `src/serve/dashboard.ts`

**Changes:**

1. Add `<div id="specflow-pipeline"></div>` block between the `#summary` stats and the Search Events section:

```html
<h2>SpecFlow Pipeline</h2>
<div id="specflow-pipeline"><p style="color:#555">Loading...</p></div>
```

2. Add `loadSpecFlow()` function to the inline `<script>`:

```javascript
async function loadSpecFlow() {
  try {
    const res = await fetch('/api/specflow/panel');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const html = await res.text();
    document.getElementById('specflow-pipeline').innerHTML = html;
  } catch(e) {
    document.getElementById('specflow-pipeline').innerHTML =
      '<p style="color:#f44336">Unable to load pipeline data. Will retry.</p>';
  }
}
```

3. Add to `refresh()`: `loadSpecFlow();`
4. Add to initial `refresh()` call (already happens via `refresh()` on line 106).

**Placement:** SpecFlow section appears directly after `<div id="summary"></div>`, before "Search Events" — highest-priority actionable info first.

---

## File Structure

```
src/serve/
├── api/
│   └── specflow-pipeline.ts   REWRITE — thin adapter over bb.listFeatures()
├── views/
│   └── specflow-panel.ts      REWRITE — 11-phase track, scores, failures, PR, timeline
├── server.ts                  MODIFY — swap import + route handler, remove /pipelines route
└── dashboard.ts               MODIFY — add SpecFlow section + loadSpecFlow()
```

No new files. No changes to `ivy-blackboard`.

---

## Dependencies

| Dependency | Status | Notes |
|-----------|--------|-------|
| `bb.listFeatures()` | Existing (F-027 Phase 2) | Wired in server.ts; just needs calling from panel |
| `SpecFlowFeature` type | Existing | From ivy-blackboard, already available to server.ts |
| `/api/specflow/features/:id/events` | Existing (T-2.7) | Used by click-to-expand; no changes needed |
| No new npm packages | Required (NFR-1) | Vanilla JS only |

---

## Test Strategy

**Test file:** `test/specflow-panel.test.ts` (new file, alongside `test/server.test.ts`)

### Unit Tests

| Test | What it covers |
|------|---------------|
| `getSpecFlowFeaturesView returns bb.listFeatures() result` | Thin adapter returns exactly what blackboard returns |
| `renderSpecFlowPanel with empty array renders placeholder` | Empty state: "No active SpecFlow features" text present |
| `renderSpecFlowPanel with active feature renders phase track` | 11 phase dots rendered; active phase has `data-state="active"` |
| `renderSpecFlowPanel with failed feature renders terminal badge` | status=failed replaces track with red badge |
| `renderSpecFlowPanel with blocked feature renders orange badge` | status=blocked renders orange badge |
| `phaseState(feature, phase) for completed phase returns "completed"` | idx < cur → `"completed"` |
| `phaseState(feature, phase) for active phase returns "active"` | idx === cur AND ACTIVE_PHASES has phase → `"active"` |
| `phaseState(feature, phase) for pending phase returns "pending"` | idx > cur → `"pending"` |
| `renderSpecFlowPanel escapes HTML in title and feature_id` | XSS: `<script>` in title → `&lt;script&gt;` in output |
| `renderSpecFlowPanel renders scores as "92 / 85 / –" format` | null scores render as `–`; numbers render as integers |
| `renderSpecFlowPanel renders PR link when pr_url is https://` | `<a href>` present with correct text |
| `renderSpecFlowPanel omits PR link for non-https urls` | Security: `javascript:` URLs not rendered as links |
| `/api/specflow/panel returns 200 with HTML fragment` | Integration: route wired correctly in server.ts |
| `/api/specflow/panel returns 500 with JSON error when bb throws` | Error handling: server catches and returns structured error |

### Performance Verification

```typescript
// In test/specflow-panel.test.ts:
test('renderSpecFlowPanel renders 50 features in < 50ms', () => {
  const features = Array.from({ length: 50 }, (_, i) => mockFeature({ feature_id: `f-${i}` }));
  const start = performance.now();
  renderSpecFlowPanel(features);
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(50);
});
```

### Acceptance Criteria Table

| Spec Success Criterion | Test Case | Verification Method |
|---|---|---|
| Panel reads from `specflow_features`, not work items | `getSpecFlowFeaturesView returns bb.listFeatures() result` | Unit: assert return value equals mock `listFeatures()` output |
| 11 phases visible | `renderSpecFlowPanel with active feature renders phase track` | Unit: count `data-phase` attribute occurrences = 11 |
| Failure visibility | `renders failure badge when failure_count > 0` | Unit: badge text `"2/3"` present in output |
| Eval scores shown | `renders scores as "92 / 85 / –" format` | Unit: assert score string in rendered HTML |
| PR links clickable | `renders PR link when pr_url is https://` | Unit: `<a href="https://...">` in output |
| Event timeline works | Manual test only (click-to-expand uses browser fetch) | Browser: click row, verify timeline appears |
| Dashboard auto-refresh | `dashboard.ts includes loadSpecFlow in refresh()` | Grep: `loadSpecFlow` in `refresh` function body |
| Dead code removed | `specflow-pipeline.ts has no PipelineFeature` | Static: `bun tsc --noEmit`; Grep: no `PipelineFeature` |
| < 50ms for 50 features | Performance test in test file | Unit: `performance.now()` before/after render |
| 30s auto-refresh | Dashboard loads every 30s | Browser: check `setInterval` arg = 30000 |

### TDD Approach

Write failing tests for `getSpecFlowFeaturesView` and `renderSpecFlowPanel` before implementing. The test file imports types from `ivy-blackboard` — same path as `server.ts` uses.

### NFR Verification Strategy

| NFR | Verification |
|-----|-------------|
| No new dependencies | `git diff package.json` — no new entries |
| < 50ms for 50 features | Performance test in `specflow-panel.test.ts` |
| No breaking changes to `/api/specflow/features` | Existing server tests still pass: `bun test test/server.test.ts` |
| XSS safety | Unit test with `<script>alert(1)</script>` in title; verify `&lt;script&gt;` in output |
| 30s auto-refresh | Grep for `setInterval` / `setTimeout` with 30000ms arg in `dashboard.ts` |

---

## Error Handling & Failure Resilience

### Server-Side Failures

| Failure Mode | Detection | Recovery |
|---|---|---|
| `bb.listFeatures()` throws synchronously | try/catch in `/api/specflow/panel` handler | Return `{ error: "..." }` JSON with HTTP 500 |
| `bb.listFeatures()` returns `undefined` | Guard: `const features = bb.listFeatures() ?? []` | Treat as empty array → render placeholder |
| `bb.listFeatures()` returns partial result (DB locked) | Same guard | Render partial data; log warning |
| `renderSpecFlowPanel` throws (bug in view layer) | Outer try/catch in route handler | 500 with stack trace in server log; client retries on next 30s cycle |
| Feature with unknown phase value | `phaseState` returns `"pending"` for unknown phases | Unknown phase renders as gray dot with raw phase name — no crash |

**Server.ts error handler pattern:**
```typescript
try {
  const features = bb.listFeatures() ?? [];
  const html = renderSpecFlowPanel(features);
  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
} catch (err) {
  console.error('[specflow/panel]', err);
  return new Response(JSON.stringify({ error: String(err) }), {
    status: 500,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

### Client-Side Failures

| Failure Mode | User Experience | Recovery |
|---|---|---|
| `/api/specflow/panel` returns 500 | Red "Unable to load pipeline data" message in `#specflow-pipeline` div | Silently retried on next 30s refresh |
| Fetch timeout (> 5s) | Stale data preserved from previous render; "(stale)" indicator | Auto-retry on next cycle |
| `/api/specflow/features/:id/events` returns 404 | "No events found for this feature" inline | Expander collapses; no crash |
| Network unreachable | Red error message | Auto-retry |

### Degraded Performance (> 50 features)

`bb.listFeatures()` is a single indexed SQLite query. For 50+ features:
- Response time degrades linearly (each feature adds ~0.5ms render time)
- No server-side pagination needed for current scale (< 20 active features typical)
- If needed: filter to non-completed features with `bb.listFeatures({ status: ['pending', 'active', 'failed', 'blocked'] })`

---

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| Import path for `SpecFlowFeature` differs from expected | Medium | Low | Check existing `bb.listFeatures()` call in server.ts for how types are resolved; use same import path |
| `bb.listFeatures()` signature mismatch (options vs no-args) | Medium | Low | server.ts already calls `bb.listFeatures({ projectId, phase, status })` — call with no args for panel (returns all) |
| Phase track wraps/overflows on narrow screens | Low | Medium | Use `overflow-x: auto` wrapper (already in old panel); abbreviate phase labels to 3-letter codes if needed |
| Event timeline fetch returns search results (FTS) not typed events | Low | High | Current T-2.7 uses `bb.eventQueries.search(featureId)` — result shape is `{rank, event}[]` not plain events; render accordingly |
| Inline JS in panel fragment conflicts with dashboard JS globals | Low | Low | Scope panel JS with IIFE or use `data-feature-id` attributes; avoid polluting window globals |
| `last_error` / `title` contain HTML special chars from agent output | Medium | Medium | All agent strings go through `escapeHtml()` before insertion; no raw `innerHTML` from feature data |

---

## Success Checklist (maps to spec success criteria)

- [ ] Panel reads from `specflow_features` via `bb.listFeatures()`, not work items
- [ ] 11-phase track rendered with completed/active/pending states
- [ ] Features with `failure_count > 0` show orange/red badge
- [ ] `specify_score`, `plan_score`, `implement_score` shown inline
- [ ] `pr_url` rendered as clickable anchor when set
- [ ] Click on feature row fetches `/:id/events` and renders inline timeline
- [ ] SpecFlow section in dashboard auto-refreshes every 30s
- [ ] Old `PipelineFeature` interface and correlation logic removed
- [ ] No new npm dependencies added
- [ ] Panel endpoint responds < 50ms for 50 features
