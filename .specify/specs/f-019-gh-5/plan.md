# Technical Plan: GH-5 — Tana Task Agent

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                        Heartbeat Pipeline                                │
│                                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐               │
│  │  Checklist    │───>│  Runner      │───>│  Evaluators  │               │
│  │  (YAML)      │    │  (runner.ts) │    │  (registry)  │               │
│  └──────────────┘    └──────────────┘    └──────┬───────┘               │
│                                                  │                       │
│          ┌──────────────────┬────────────────────┼───────────────┐       │
│          ▼                  ▼                    ▼               ▼       │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐ ┌─────────────┐ │
│  │  calendar    │  │ github_issues│  │ tana_todos    │ │    ...      │ │
│  └──────────────┘  └──────────────┘  │ (NEW)         │ └─────────────┘ │
│                                      └───────┬───────┘                  │
│                                              │                          │
│                    ┌─────────────────────────┬┘                         │
│                    ▼                         ▼                          │
│            ┌──────────────┐         ┌──────────────┐                    │
│            │ TanaAccessor │         │ Blackboard   │                    │
│            │ (injectable) │         │ Accessor     │                    │
│            └──────┬───────┘         └──────────────┘                    │
│                   │                                                      │
└───────────────────┼──────────────────────────────────────────────────────┘
                    │
                    ▼
            ┌──────────────┐
            │ tana-local   │
            │ MCP Server   │
            │ (external)   │
            └──────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                      Dispatch Pipeline                                    │
│                                                                          │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐       │
│  │  Scheduler   │───>│  Dispatch    │───>│  Claude Code Agent   │       │
│  │  (claim)     │    │  Worker      │    │  (execution)         │       │
│  └──────────────┘    └──────┬───────┘    └──────────┬───────────┘       │
│                             │                        │                   │
│                             │  ┌─────────────────────┘                  │
│                             ▼  ▼                                         │
│                      ┌──────────────────┐                                │
│                      │ Post-Execution   │                                │
│                      │ ┌──────────────┐ │                                │
│                      │ │ GitHub path  │ │ (existing: commit/PR/comment) │
│                      │ ├──────────────┤ │                                │
│                      │ │ SpecFlow     │ │ (existing: phase chain)       │
│                      │ ├──────────────┤ │                                │
│                      │ │ Tana path    │ │ (NEW: write-back + check-off) │
│                      │ │ (NEW)        │ │                                │
│                      │ └──────────────┘ │                                │
│                      └──────────────────┘                                │
└──────────────────────────────────────────────────────────────────────────┘
```

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Project standard |
| Schema validation | Zod | Project pattern (CheckTypeSchema, ChecklistItemSchema) |
| Database | SQLite via ivy-blackboard | Project standard for work items |
| Testing | bun:test | Project standard |
| Tana integration | tana-local MCP (process-local function calls) | MCP server already running; matches specification |
| Content filtering | pai-content-filter (injectable) | Existing pattern from github-issues.ts |

### MCP Invocation Strategy (Open Question #2 Resolution)

**Decision: Direct MCP tool function calls via subprocess.**

The tana-local MCP server exposes tools (`search_nodes`, `read_node`, `check_node`, `import_tana_paste`). The evaluator will invoke these via a `TanaAccessor` interface that wraps subprocess calls to the MCP CLI, mirroring how `github-issues.ts` wraps `gh` CLI calls via `Bun.spawn`. This keeps the pattern consistent and the dependency injectable.

The default `TanaAccessor` implementation will call `bunx @anthropic-ai/claude-code-mcp tana-local <tool>` or, more practically, invoke the tana-local server's HTTP transport directly. Since the MCP server is already running locally (available via Claude Code's MCP integration), the simplest approach is a thin wrapper that calls the server's tool endpoints.

**Recommended approach:** Shell out to a small helper script (`src/evaluators/tana-mcp-client.ts`) that sends JSON-RPC calls to the tana-local MCP server's stdio transport. This isolates MCP protocol details from the evaluator logic.

### Single Workspace (Open Question #3 Resolution)

**Decision: Single workspace for initial implementation.** The workspace ID will be provided via checklist config. Multi-workspace support can be added later by making `workspace_id` an array.

### Structured Fields (Open Question #1 Resolution)

**Decision: Start without structured fields.** The base integration uses node name (title) and child content (description). Priority, Deadline, and Assignee fields can be added incrementally after the core loop works. The config already supports `project_field_id` for project association.

## Data Model

### TanaAccessor Interface

```typescript
/**
 * Injectable Tana MCP accessor — mirrors the BlackboardAccessor pattern.
 * Each method maps to a tana-local MCP tool.
 */
export interface TanaAccessor {
  /** search_nodes with hasType filter for ivy-todo tag, unchecked only */
  searchTodos(opts: {
    tagId: string;
    workspaceId?: string;
    limit?: number;
  }): Promise<TanaNode[]>;

  /** read_node with depth to get child content */
  readNode(nodeId: string, maxDepth?: number): Promise<TanaNodeContent>;

  /** import_tana_paste to add result child under a node */
  addChildContent(parentNodeId: string, content: string): Promise<void>;

  /** check_node to mark todo as done */
  checkNode(nodeId: string): Promise<void>;
}
```

### Tana Node Types

```typescript
interface TanaNode {
  id: string;
  name: string;          // Node title (= work item title)
  tags?: string[];
  workspaceId?: string;
  description?: string;
  created?: string;
}

interface TanaNodeContent {
  id: string;
  name: string;
  markdown: string;      // Full markdown content including children
  children?: string[];   // Child node content as strings
}
```

### Tana Work Item Metadata

```typescript
interface TanaWorkItemMetadata {
  tana_node_id: string;           // source_ref: Tana node ID
  tana_workspace_id?: string;
  tana_tag_id: string;            // The ivy-todo tag ID used
  content_filtered: boolean;
  content_blocked: boolean;
  content_warning?: boolean;
  filter_matches: string[];
  minimal_context?: boolean;      // true if no child content
  project_name?: string;          // Project matched by name
}
```

### Checklist Config Schema

```typescript
interface TanaTodosConfig {
  /** The Tana supertag ID for #ivy-todo (required) */
  tagId: string;
  /** Tana workspace ID (optional — defaults to first available) */
  workspaceId?: string;
  /** Max todos to fetch per evaluation (default: 20) */
  limit: number;
  /** Tana field ID for "Project" field on ivy-todo nodes (optional) */
  projectFieldId?: string;
}
```

## API Contracts

### Evaluator: `evaluateTanaTodos(item: ChecklistItem): Promise<CheckResult>`

**Input:** ChecklistItem with `type: 'tana_todos'` and config fields.

**Output (new todos found):**
```typescript
{
  item,
  status: 'alert',
  summary: 'Tana todos check: Tana Todos — 3 new todo(s) found',
  details: {
    todosChecked: 15,
    newTodos: 3,
    todos: [
      { nodeId: 'abc123', title: 'Fix README typos', project: 'supertag-cli' },
      { nodeId: 'def456', title: 'Add tests for parser', project: null },
    ]
  }
}
```

**Output (no new todos):**
```typescript
{
  item,
  status: 'ok',
  summary: 'Tana todos check: Tana Todos — no new todos',
  details: { todosChecked: 15, newTodos: 0 }
}
```

**Output (MCP unavailable):**
```typescript
{
  item,
  status: 'error',
  summary: 'Tana todos check: Tana Todos — error: tana-local MCP server not reachable',
  details: { error: 'tana-local MCP server not reachable' }
}
```

### Dispatch Worker: `parseTanaMeta(metadata: string | null)`

**Input:** Work item metadata JSON string.

**Output:**
```typescript
{
  isTana: boolean;
  nodeId?: string;
  workspaceId?: string;
  tagId?: string;
}
```

### Tana Write-back Format

**On success:**
```
- ✅ Ivy completed this task
  - **Result:** [Agent summary from work item completion]
  - **PR:** [URL if applicable]
  - **Completed:** [ISO timestamp]
```

**On failure:**
```
- ❌ Ivy encountered an error
  - **Error:** [Error description]
  - **Attempted:** [ISO timestamp]
  - **Status:** Task left pending for retry or manual action
```

## Implementation Phases

### Phase 1: Schema & Types (Est: 15 min)

**Goal:** Add `tana_todos` to the type system.

1. Add `'tana_todos'` to `CheckTypeSchema` enum in `src/parser/types.ts`
2. Create `src/evaluators/tana-types.ts` with:
   - `TanaAccessor` interface
   - `TanaNode`, `TanaNodeContent` types
   - `TanaTodosConfig` interface
   - `TanaWorkItemMetadata` interface

**Files modified:**
- `src/parser/types.ts` — add enum value
- `src/evaluators/tana-types.ts` — new file

### Phase 2: TanaAccessor Default Implementation (Est: 30 min)

**Goal:** Create the default MCP client wrapper.

1. Create `src/evaluators/tana-accessor.ts` with:
   - Default `TanaAccessor` implementation using `Bun.spawn` to call tana-local MCP
   - Injectable setter/reset pattern (matching `setIssueFetcher`/`resetIssueFetcher`)
   - Graceful error handling for MCP unavailability
   - 10-second timeout per MCP call (NFR-1)

**MCP invocation approach:**
The tana-local MCP server runs as a stdio-based MCP server. For the evaluator (which runs outside Claude Code's MCP context), we need a lightweight client. The simplest approach:

```typescript
// Use Bun.spawn to invoke a helper that sends JSON-RPC to tana-local
// OR use the tana-local REST API if available
// OR invoke via mcp CLI tool
```

**Practical approach:** Since the heartbeat runs as a CLI process (not inside Claude Code), it cannot directly call MCP tools. The accessor will:
1. Import and call tana-local functions directly if the package is available as a dependency
2. Fall back to HTTP calls if tana-local exposes an HTTP endpoint
3. Fall back to subprocess invocation as last resort

**Recommended:** Add `tana-local` as an optional peer dependency and import its search/read/check/import functions directly. This avoids MCP protocol overhead and is the most testable approach.

**Files created:**
- `src/evaluators/tana-accessor.ts`

### Phase 3: Evaluator Implementation (Est: 45 min)

**Goal:** Create the core evaluator with full feature parity to spec.

1. Create `src/evaluators/tana-todos.ts` with:
   - `parseTanaTodosConfig(item: ChecklistItem): TanaTodosConfig`
   - Injectable `TanaAccessor` (setter/reset pattern)
   - Injectable `ContentFilterFn` (reuse from github-issues pattern)
   - Injectable `BlackboardAccessor` (reuse pattern)
   - `evaluateTanaTodos(item: ChecklistItem): Promise<CheckResult>`

**Evaluator flow:**
```
1. Guard: check bbAccessor is set
2. Guard: check tanaAccessor is set
3. Parse config (tagId required)
4. Call tanaAccessor.searchTodos({ tagId, limit })
5. For each todo node:
   a. Check dedup: source_ref match against existing work items
   b. Read child content: tanaAccessor.readNode(nodeId, 2)
   c. Content filter: contentFilter(childContent, label)
   d. Project association: match project field value to blackboard projects
   e. Create work item with source='tana', sourceRef=nodeId
6. Return CheckResult with counts
```

**Key decisions:**
- `source: 'tana'` distinguishes from `'github'` and `'specflow'`
- `source_ref` stores the Tana node ID (not a URL, since Tana nodes don't have stable URLs)
- Work item ID format: `tana-<nodeId>` (simple, deterministic)
- Content filter runs on concatenated child content (the "instructions")

**Files created:**
- `src/evaluators/tana-todos.ts`

### Phase 4: Registry & Runner Integration (Est: 15 min)

**Goal:** Wire the evaluator into the heartbeat pipeline.

1. Register `evaluateTanaTodos` in `src/check/evaluators.ts`
2. Add `setTanaBlackboardAccessor` / `resetTanaBlackboardAccessor` calls to `src/check/runner.ts` (matching the github-issues pattern)
3. Optionally add `setTanaAccessor` initialization in runner (or rely on default)

**Files modified:**
- `src/check/evaluators.ts` — import + register
- `src/check/runner.ts` — wire up accessor like github-issues

### Phase 5: Dispatch Worker Tana Write-back (Est: 30 min)

**Goal:** Add post-execution Tana write-back for completed work items.

1. Add `parseTanaMeta()` function to `src/commands/dispatch-worker.ts`
2. Add Tana write-back block after the existing GitHub post-execution block:
   - On success (exit code 0):
     - Import result summary as child node via `import_tana_paste`
     - Check off the `#ivy-todo` node via `check_node`
   - On failure (non-zero exit):
     - Import error context as child node
     - Leave node unchecked
3. Write-back failures are non-fatal (NFR-4) — wrapped in try/catch with event logging

**Integration point:** The dispatch worker already has the pattern:
```typescript
// Line 145: const sfMeta = parseSpecFlowMeta(item.metadata);
// Line 184: const ghMeta = parseGithubMeta(item.metadata);
// NEW:      const tanaMeta = parseTanaMeta(item.metadata);
```

The Tana write-back will happen:
- **After** agent execution completes (same as GitHub PR creation)
- **Before** `completeWorkItem` / `releaseWorkItem` calls
- Using the same `TanaAccessor` interface (imported and used directly)

**Files modified:**
- `src/commands/dispatch-worker.ts` — add parseTanaMeta + write-back logic

### Phase 6: Tests (Est: 60 min)

**Goal:** Comprehensive test coverage matching github-issues.test.ts patterns.

1. Create `test/tana-todos.test.ts` with:
   - Config parsing tests (defaults, custom values, missing tagId)
   - Mock TanaAccessor returning controlled responses
   - New todo detection (happy path)
   - Duplicate prevention (source_ref match)
   - Content filtering (allowed, blocked, encoding-only)
   - Project association by name match
   - Minimal context (no child nodes)
   - MCP unavailable (graceful error)
   - Empty results (no todos found)

2. Create `test/dispatch-tana.test.ts` with:
   - `parseTanaMeta` parsing tests
   - Write-back on success (mock TanaAccessor)
   - Write-back on failure
   - Write-back failure is non-fatal

**Test setup pattern:**
```typescript
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hb-tana-'));
  bb = new Blackboard(join(tmpDir, 'test.db'));
  setTanaBlackboardAccessor(bb);
  setTanaAccessor(mockTanaAccessor);
  setTanaContentFilter(async () => FILTER_ALLOW);
});

afterEach(() => {
  resetTanaAccessor();
  resetTanaBlackboardAccessor();
  resetTanaContentFilter();
  bb.close();
  rmSync(tmpDir, { recursive: true, force: true });
});
```

**Files created:**
- `test/tana-todos.test.ts`
- `test/dispatch-tana.test.ts`

## File Structure

```
src/
├── evaluators/
│   ├── github-issues.ts          # Existing (reference pattern)
│   ├── tana-types.ts             # NEW: Types, interfaces, config
│   ├── tana-accessor.ts          # NEW: Injectable TanaAccessor + default impl
│   └── tana-todos.ts             # NEW: Main evaluator
├── commands/
│   └── dispatch-worker.ts        # MODIFIED: Add parseTanaMeta + write-back
├── check/
│   ├── evaluators.ts             # MODIFIED: Register tana_todos
│   └── runner.ts                 # MODIFIED: Wire accessor
├── parser/
│   └── types.ts                  # MODIFIED: Add 'tana_todos' to CheckTypeSchema
test/
├── github-issues.test.ts         # Existing (reference pattern)
├── tana-todos.test.ts            # NEW: Evaluator tests
└── dispatch-tana.test.ts         # NEW: Dispatch write-back tests
```

**Total: 3 new files, 4 modified files, 2 new test files**

## Dependencies

### Required (Already Available)

| Dependency | Version | Used For |
|-----------|---------|----------|
| `zod` | ^4.3.6 | Config schema validation |
| `ivy-blackboard` | local | Work item CRUD |
| `bun:test` | built-in | Testing |
| `bun:sqlite` | built-in | Database (via ivy-blackboard) |

### External (Runtime Dependency)

| Dependency | Required | Notes |
|-----------|----------|-------|
| `tana-local` MCP server | Yes (runtime) | Must be running on the machine. Not bundled — listed in prerequisites. |

### No New Package Dependencies

The evaluator uses `Bun.spawn` to communicate with tana-local (same pattern as `gh` CLI in github-issues). No new npm packages needed.

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **tana-local MCP not running** | Evaluator returns error every cycle | Medium | Graceful error handling (NFR-7). Return `status: 'error'` without crashing. Log clear message. |
| **Tana node ID format changes** | Source_ref dedup breaks | Low | Node IDs are stable in Tana. Use exact string match. |
| **MCP call latency exceeds 10s** | Blocks heartbeat loop | Low | Per-call timeout of 10s (NFR-1). Abort and return error on timeout. |
| **Content in Tana contains prompt injection** | Agent executes malicious instructions | Medium | Content filter runs on ALL child content (NFR-5). Blocked content sets `human_review_required: true`. |
| **MCP invocation from CLI process** | Can't call MCP tools directly (they're Claude Code internal) | High | **Key risk.** The default TanaAccessor must work outside Claude Code's MCP context. Options: (a) direct function import if tana-local is a library, (b) HTTP transport, (c) stdio subprocess. Needs investigation of tana-local's transport layer. |
| **Write-back fails after work completes** | Tana todo stays unchecked despite work being done | Medium | Non-fatal (NFR-4). Work item lifecycle completes regardless. User can manually check off in Tana. Log the failure. |
| **Race condition: same todo processed twice** | Duplicate work items | Low | Dedup by `source_ref` before creating work item. `createWorkItem` with same ID throws (caught). |
| **Large child content from Tana** | Memory/performance issues | Low | Use `read_node` with `maxDepth: 2`. Truncate content at 10KB before content filtering. |

### Critical Risk: MCP Access from Heartbeat Process

The highest risk is MCP invocation. The heartbeat runs as a standalone CLI process (`bun run src/cli.ts check`), not within Claude Code's MCP framework. The tana-local MCP server tools (`search_nodes`, `read_node`, etc.) are designed for Claude Code's MCP integration.

**Mitigation options (in order of preference):**

1. **Direct import** — If tana-local exposes its functions as a library (not just MCP tools), import them directly. This is the most reliable and testable approach.

2. **MCP stdio subprocess** — Spawn tana-local's MCP server as a child process, send JSON-RPC requests over stdio, parse responses. This works but adds complexity.

3. **HTTP endpoint** — If tana-local has an HTTP transport mode, call it via `fetch()`. Cleanest network approach.

4. **Deferred execution** — The evaluator creates work items from a snapshot/cache that Claude Code populates when it runs (e.g., a JSON file written by a hook). This decouples the heartbeat from live MCP calls.

**Recommendation:** Start with option 1 (direct import). If tana-local is not importable, fall back to option 2 (stdio subprocess). The `TanaAccessor` interface abstracts this decision — the evaluator doesn't care how MCP calls happen.

## Verification Checklist

| # | Criterion | How to Verify |
|---|-----------|---------------|
| 1 | `tana_todos` accepted as CheckType | `CheckTypeSchema.parse('tana_todos')` succeeds |
| 2 | Evaluator returns CheckResult | Unit test: mock accessor, assert result shape |
| 3 | New todos create work items | Unit test: assert `createWorkItem` called with `source: 'tana'` |
| 4 | Duplicates skipped | Unit test: pre-seed work item, re-run evaluator, assert no new items |
| 5 | Content filter runs on input | Unit test: mock filter returning BLOCKED, assert metadata |
| 6 | MCP failure = graceful error | Unit test: mock accessor throwing, assert `status: 'error'` |
| 7 | Write-back on success | Unit test: mock accessor, assert `addChildContent` + `checkNode` called |
| 8 | Write-back on failure | Unit test: mock accessor, assert `addChildContent` called, `checkNode` NOT called |
| 9 | Write-back failure is non-fatal | Unit test: mock accessor throwing on write-back, assert work item still completes |
| 10 | Existing evaluators unaffected | Run full test suite, all existing tests pass |

## Estimated Effort

| Phase | Estimate | Cumulative |
|-------|----------|------------|
| Phase 1: Schema & Types | 15 min | 15 min |
| Phase 2: TanaAccessor | 30 min | 45 min |
| Phase 3: Evaluator | 45 min | 1h 30min |
| Phase 4: Registry Integration | 15 min | 1h 45min |
| Phase 5: Dispatch Write-back | 30 min | 2h 15min |
| Phase 6: Tests | 60 min | 3h 15min |
| **Total** | **~3.25 hours** | |
