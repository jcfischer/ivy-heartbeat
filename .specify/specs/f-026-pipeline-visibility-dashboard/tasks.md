# Implementation Tasks: F-026 Pipeline Visibility Dashboard

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | ☐ | |
| T-2.1 | ☐ | |
| T-2.2 | ☐ | |
| T-3.1 | ☐ | |
| T-4.1 | ☐ | |
| T-5.1 | ☐ | |
| T-5.2 | ☐ | |
| T-5.3 | ☐ | |

---

## Group 1: Data Layer

### T-1.1: Rewrite specflow-pipeline.ts as thin adapter [T]

- **File:** `src/serve/api/specflow-pipeline.ts`
- **Test:** `test/specflow-panel.test.ts` (new file, T-5.1 covers this)
- **Dependencies:** none
- **Description:** Remove `PipelineFeature` interface, `ALL_PHASES` constant, and the entire `getSpecFlowPipelines()` correlation body. Replace with a thin adapter that re-exports `SpecFlowFeature` and calls `bb.listFeatures()`:

  ```typescript
  import type { Blackboard } from '../../blackboard.ts';
  import type { SpecFlowFeature } from 'ivy-blackboard/src/types.ts';

  export type { SpecFlowFeature };

  export function getSpecFlowFeaturesView(bb: Blackboard): SpecFlowFeature[] {
    return bb.listFeatures() ?? [];
  }
  ```

  **Verify import path:** Check how `SpecFlowFeature` is imported in `src/serve/server.ts` (line 100 calls `bb.listFeatures()`) and use the same pattern — it may be re-exported from `../../blackboard.ts` rather than imported directly from `ivy-blackboard/src/types.ts`.

---

## Group 2: View Layer

### T-2.1: Rewrite specflow-panel.ts — 11-phase track, scores, failures, PR, event timeline [T]

- **File:** `src/serve/views/specflow-panel.ts`
- **Test:** `test/specflow-panel.test.ts` (new file, T-5.2 covers this)
- **Dependencies:** T-1.1
- **Description:** Full rewrite of `renderSpecFlowPanel()` to accept `SpecFlowFeature[]` (from ivy-blackboard types) instead of `PipelineFeature[]`. Implement:

  **Phase constants and classifier:**
  ```typescript
  const ACTIVE_PHASES = new Set([
    'specifying', 'planning', 'tasking', 'implementing', 'completing'
  ]);
  const DISPLAY_PHASES = [
    'queued', 'specifying', 'specified', 'planning', 'planned',
    'tasking', 'tasked', 'implementing', 'implemented', 'completing', 'completed'
  ];

  function phaseState(feature: SpecFlowFeature, phase: string): 'completed' | 'active' | 'pending' {
    const idx = DISPLAY_PHASES.indexOf(phase);
    const cur = DISPLAY_PHASES.indexOf(feature.phase);
    if (idx < cur) return 'completed';
    if (idx === cur && ACTIVE_PHASES.has(phase)) return 'active';
    if (idx === cur) return 'completed'; // terminal *ed states (queued counts as completed-before-start)
    return 'pending';
  }
  ```

  **Table columns:**
  | Column | Source |
  |--------|--------|
  | Feature | `feature_id` (monospace, `data-feature-id` attr for JS) |
  | Title | `title.slice(0, 40)` (escaped) |
  | Pipeline | 11-dot phase track OR terminal badge if `status === 'failed'/'blocked'` |
  | Scores | `specify_score ?? '–'` / `plan_score ?? '–'` / `implement_score ?? '–'` |
  | Failures | Hidden if `failure_count === 0`; orange badge if `≥ 1`; red if `=== max_failures` |
  | PR | `<a href="...">#{pr_number}</a>` if `pr_url` starts with `https://`; else `–` |
  | Updated | `relTimeAgo(updated_at)` |

  **Phase dot styling (inline CSS):**
  - `completed`: green dot `#22c55e`, solid circle `●`
  - `active`: blue pulsing dot `#3b82f6`, solid circle `●` with CSS animation or `▶`
  - `pending`: gray dot `#6b7280`, hollow circle `○`
  - Terminal `failed` (status): red badge `✗ failed` replaces phase track
  - Terminal `blocked` (status): orange badge `⚠ blocked` replaces phase track

  **Click-to-expand event timeline (IIFE-scoped inline JS in the returned HTML fragment):**
  ```javascript
  (function() {
    let expanded = null;
    document.querySelectorAll('[data-feature-id]').forEach(row => {
      row.style.cursor = 'pointer';
      row.addEventListener('click', async function() {
        const id = this.dataset.featureId;
        const existingTimeline = document.getElementById('tl-' + id);
        if (existingTimeline) {
          existingTimeline.remove();
          expanded = null;
          return;
        }
        if (expanded) {
          const prev = document.getElementById('tl-' + expanded);
          if (prev) prev.remove();
        }
        expanded = id;
        const tr = document.createElement('tr');
        tr.id = 'tl-' + id;
        tr.innerHTML = '<td colspan="7" style="padding:8px 16px;background:#111">Loading…</td>';
        this.insertAdjacentElement('afterend', tr);
        try {
          const res = await fetch('/api/specflow/features/' + encodeURIComponent(id) + '/events');
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const events = await res.json();
          if (!events.length) {
            tr.querySelector('td').textContent = 'No events found for this feature.';
            return;
          }
          // events is Array<{rank, event}> per T-2.7 implementation
          const rows = events.map(r => {
            const e = r.event || r;
            const ts = e.timestamp ? new Date(e.timestamp).toLocaleTimeString() : '?';
            const summary = (e.summary || '').slice(0, 120);
            return '<tr style="background:#0d0d0d"><td></td><td style="color:#6b7280;font-size:11px">' + ts + '</td><td colspan="5">' + summary + '</td></tr>';
          }).join('');
          tr.outerHTML = rows;
        } catch(e) {
          tr.querySelector('td').textContent = 'Error loading events: ' + e.message;
        }
      });
    });
  })();
  ```

  **XSS safety:** All `feature_id`, `title`, `last_error` content passed through `escapeHtml()` before insertion. `pr_url` validated to start with `https://` before rendered as `<a href>`. Timeline events inserted via template string but event summaries are escaped.

  **Empty state:** When `features.length === 0`, return `<div style="...">No active SpecFlow features.</div>`.

---

## Group 3: Server Route Update

### T-3.1: Update server.ts — swap imports and fix /api/specflow/panel route [T]

- **File:** `src/serve/server.ts`
- **Test:** `test/serve.test.ts` (extend existing file, T-5.3 covers this)
- **Dependencies:** T-1.1, T-2.1
- **Description:** Three changes:

  1. **Swap import** (line 4):
     ```typescript
     // Remove:
     import { getSpecFlowPipelines } from './api/specflow-pipeline.ts';
     // Add:
     import { getSpecFlowFeaturesView } from './api/specflow-pipeline.ts';
     ```

  2. **Update `/api/specflow/panel` route handler** (currently lines 76–82):
     ```typescript
     if (path === '/api/specflow/panel') {
       try {
         const features = getSpecFlowFeaturesView(bb);
         const html = renderSpecFlowPanel(features);
         return new Response(html, {
           headers: { ...headers, 'Content-Type': 'text/html' },
         });
       } catch (err) {
         console.error('[specflow/panel]', err);
         return new Response(JSON.stringify({ error: String(err) }), {
           status: 500,
           headers: { ...headers, 'Content-Type': 'application/json' },
         });
       }
     }
     ```

  3. **Remove dead `/api/specflow/pipelines` route** (currently lines 70–73) — this route used old correlation code and has no clients.

  No other changes to `server.ts`. The existing `/api/specflow/features`, `/:id`, and `/:id/events` routes remain unchanged.

---

## Group 4: Dashboard Integration

### T-4.1: Add SpecFlow section to dashboard.ts [T]

- **File:** `src/serve/dashboard.ts`
- **Test:** `test/serve.test.ts` (extend existing `dashboard HTML` describe block, T-5.3 covers this)
- **Dependencies:** T-3.1
- **Description:** Two changes to `generateDashboardHTML()`:

  1. **Add HTML placeholder** — insert after `<div id="summary"></div>` (line 36), before `<h2>Search Events</h2>` (line 38):
     ```html
     <h2>SpecFlow Pipeline</h2>
     <div id="specflow-pipeline"><p style="color:#555;font-style:italic">Loading...</p></div>
     ```

  2. **Add `loadSpecFlow()` function** to the inline `<script>` block and wire it into `refresh()`. Insert before `function refresh()`:
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

  3. **Update `refresh()` function** to include `loadSpecFlow()`:
     ```javascript
     function refresh() { loadSummary(); loadEvents(); loadHeartbeats(); loadSpecFlow(); }
     ```

  No other changes. The `setInterval(refresh, 30000)` at line 107 already provides 30-second auto-refresh.

---

## Group 5: Tests

### T-5.1: Unit tests — getSpecFlowFeaturesView adapter [T] [P with T-5.2]

- **File:** `test/specflow-panel.test.ts` (new file)
- **Dependencies:** T-1.1
- **Description:** Create `test/specflow-panel.test.ts` and add tests for the data adapter:

  ```typescript
  import { describe, test, expect, mock } from 'bun:test';
  import { getSpecFlowFeaturesView } from '../src/serve/api/specflow-pipeline.ts';

  describe('getSpecFlowFeaturesView', () => {
    test('returns exactly what bb.listFeatures() returns', () => {
      const mockFeatures = [{ feature_id: 'f-001', title: 'Test' /* ... */ }];
      const bb = { listFeatures: mock(() => mockFeatures) } as any;
      expect(getSpecFlowFeaturesView(bb)).toBe(mockFeatures);
    });

    test('returns empty array when bb.listFeatures() returns null/undefined', () => {
      const bb = { listFeatures: mock(() => undefined) } as any;
      expect(getSpecFlowFeaturesView(bb)).toEqual([]);
    });
  });
  ```

### T-5.2: Unit tests — renderSpecFlowPanel view [T] [P with T-5.1]

- **File:** `test/specflow-panel.test.ts` (same file as T-5.1)
- **Dependencies:** T-2.1
- **Description:** Add `renderSpecFlowPanel` tests to the test file. Use a `mockFeature()` helper to reduce duplication:

  ```typescript
  function mockFeature(overrides: Partial<SpecFlowFeature> = {}): SpecFlowFeature {
    return {
      feature_id: 'f-001', project_id: 'ivy', title: 'Test Feature',
      description: null, phase: 'implementing', status: 'active',
      current_session: null, worktree_path: null, branch_name: null,
      main_branch: 'main', failure_count: 0, max_failures: 3,
      last_error: null, last_phase_error: null,
      specify_score: null, plan_score: null, implement_score: null,
      pr_number: null, pr_url: null, commit_sha: null,
      github_issue_number: null, github_issue_url: null, github_repo: null,
      source: 'manual', source_ref: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      phase_started_at: new Date().toISOString(),
      completed_at: null,
      ...overrides,
    };
  }
  ```

  **Required test cases:**

  | Test | Assertion |
  |------|-----------|
  | Empty array renders placeholder | Output contains "No active SpecFlow features" |
  | Active feature renders 11 phase dots | Count `data-phase` occurrences === 11 |
  | `status=failed` renders terminal badge | Output contains "failed" badge; no phase dots |
  | `status=blocked` renders orange badge | Output contains "blocked" badge |
  | `phaseState` for completed phase | `phaseState(f, 'queued')` returns `'completed'` when `phase='implementing'` |
  | `phaseState` for active phase | `phaseState(f, 'implementing')` returns `'active'` when `phase='implementing'` |
  | `phaseState` for pending phase | `phaseState(f, 'completing')` returns `'pending'` when `phase='implementing'` |
  | XSS: `<script>` in title escaped | `<script>` in title → `&lt;script&gt;` in output; no raw `<script>` |
  | XSS: `<script>` in feature_id escaped | Same as above for feature_id field |
  | Scores render as `"92 / 85 / –"` format | `specify_score=92, plan_score=85, implement_score=null` → string `"92 / 85 / –"` present |
  | All-null scores render as `"– / – / –"` | Three null scores → `"– / – / –"` |
  | PR link rendered for https:// URL | `pr_url='https://github.com/...'`, `pr_number=42` → `<a href="https://...">` in output |
  | PR link omitted for javascript: URL | `pr_url='javascript:alert(1)'` → no `<a href` in output |
  | Failure badge hidden when count=0 | `failure_count=0` → no badge element in output |
  | Failure badge orange when count≥1 | `failure_count=1, max_failures=3` → badge `"1/3"` with orange color style |
  | Failure badge red when count=max | `failure_count=3, max_failures=3` → red color style applied |
  | Performance: 50 features in < 50ms | `performance.now()` delta < 50ms for 50-feature array |

### T-5.3: Integration tests — server routes and dashboard [T]

- **File:** `test/serve.test.ts` (extend existing file)
- **Dependencies:** T-3.1, T-4.1
- **Description:** Extend the existing `describe('web dashboard server')` block with SpecFlow route tests, and extend `describe('dashboard HTML')`:

  **New server route tests:**
  ```typescript
  test('GET /api/specflow/panel returns 200 with text/html', async () => {
    const res = await fetch(`${baseUrl}/api/specflow/panel`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  test('GET /api/specflow/panel returns empty placeholder when no features', async () => {
    const html = await fetch(`${baseUrl}/api/specflow/panel`).then(r => r.text());
    expect(html).toContain('No active SpecFlow features');
  });

  test('GET /api/specflow/panel returns feature row when feature exists', async () => {
    bb.upsertFeature({ feature_id: 'f-001', title: 'Test Feature', /* ... */ });
    const html = await fetch(`${baseUrl}/api/specflow/panel`).then(r => r.text());
    expect(html).toContain('f-001');
  });

  test('GET /api/specflow/pipelines returns 404 (dead route removed)', async () => {
    const res = await fetch(`${baseUrl}/api/specflow/pipelines`);
    expect(res.status).toBe(404);
  });
  ```

  **New dashboard HTML tests:**
  ```typescript
  test('dashboard HTML includes specflow-pipeline div', () => {
    const html = generateDashboardHTML();
    expect(html).toContain('id="specflow-pipeline"');
  });

  test('dashboard HTML includes loadSpecFlow function', () => {
    const html = generateDashboardHTML();
    expect(html).toContain('loadSpecFlow');
    expect(html).toContain('/api/specflow/panel');
  });

  test('dashboard HTML calls loadSpecFlow in refresh()', () => {
    const html = generateDashboardHTML();
    // refresh() definition must include loadSpecFlow()
    const refreshMatch = html.match(/function refresh\(\)[^}]+\}/);
    expect(refreshMatch?.[0]).toContain('loadSpecFlow');
  });

  test('dashboard HTML auto-refreshes every 30 seconds', () => {
    const html = generateDashboardHTML();
    expect(html).toContain('setInterval(refresh, 30000)');
  });
  ```

---

## Execution Order

```
T-1.1 (data layer — no deps)
    ↓
T-2.1 (view layer — depends T-1.1 for types)
    ↓
T-3.1 (server wiring — depends T-1.1 + T-2.1)
    ↓
T-4.1 (dashboard — depends T-3.1)
    ↓
T-5.1 + T-5.2 [parallel] (unit tests — depends T-1.1 + T-2.1)
    ↓
T-5.3 (integration tests — depends T-3.1 + T-4.1)
```

**Parallelizable pairs:**
- T-5.1 and T-5.2 can be written in parallel (same output file, different describe blocks)

---

## Key Constraints

- **No new files** except `test/specflow-panel.test.ts` (test file)
- **No new npm dependencies** — inline CSS + vanilla JS only
- **Import path** for `SpecFlowFeature`: mirror what `server.ts` already uses for `bb.listFeatures()` type resolution
- **`bb.upsertFeature()`** — verify exact method name in `ivy-blackboard` before writing integration tests; it may be `createFeature` or `setFeature`
- **Event timeline events shape** — `GET /api/specflow/features/:id/events` returns `Array<{rank: number, event: Event}>` (FTS search results per T-2.7), not plain events; render `r.event.summary` not `r.summary`
