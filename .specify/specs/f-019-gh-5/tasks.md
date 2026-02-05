# Implementation Tasks: F-019 — Tana Task Agent (GH-5)

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | ☐ | Add `tana_todos` to CheckTypeSchema |
| T-1.2 | ☐ | Create Tana types & interfaces |
| T-2.1 | ☐ | Create TanaAccessor with injectable pattern |
| T-2.2 | ☐ | Create tana-todos evaluator |
| T-3.1 | ☐ | Register evaluator in registry |
| T-3.2 | ☐ | Wire accessor in runner |
| T-3.3 | ☐ | Add dispatch worker Tana write-back |
| T-4.1 | ☐ | Evaluator unit tests |
| T-4.2 | ☐ | Dispatch write-back unit tests |
| T-4.3 | ☐ | Integration: run full test suite |

## Group 1: Foundation — Schema & Types

### T-1.1: Add `tana_todos` to CheckTypeSchema [P]
- **File:** `src/parser/types.ts`
- **Dependencies:** none
- **Description:** Add `'tana_todos'` to the `CheckTypeSchema` z.enum array. This is a one-line change that unlocks the type system for the new evaluator.
- **Acceptance:**
  - `CheckTypeSchema.parse('tana_todos')` succeeds
  - All existing types still parse correctly
  - TypeScript compilation passes

### T-1.2: Create Tana types and interfaces [P with T-1.1]
- **File:** `src/evaluators/tana-types.ts` (new)
- **Dependencies:** none
- **Description:** Define all TypeScript types needed by the Tana integration:
  - `TanaAccessor` interface with `searchTodos()`, `readNode()`, `addChildContent()`, `checkNode()` methods
  - `TanaNode` — search result shape (id, name, tags, workspaceId, description, created)
  - `TanaNodeContent` — read result shape (id, name, markdown, children)
  - `TanaTodosConfig` — parsed config (tagId required, workspaceId optional, limit default 20, projectFieldId optional)
  - `TanaWorkItemMetadata` — metadata shape for work items with `source: 'tana'` (tana_node_id, tana_workspace_id, tana_tag_id, content_filtered, content_blocked, content_warning, filter_matches, minimal_context, project_name)
  - Re-export `ContentFilterResult` and `ContentFilterFn` types from github-issues (or duplicate to avoid tight coupling)

## Group 2: Core Implementation

### T-2.1: Create TanaAccessor with injectable pattern [T]
- **File:** `src/evaluators/tana-accessor.ts` (new)
- **Test:** `test/tana-todos.test.ts` (accessor tests in T-4.1)
- **Dependencies:** T-1.2
- **Description:** Create the injectable TanaAccessor following the exact pattern from `github-issues.ts` (setIssueFetcher/resetIssueFetcher):
  - Default implementation using `Bun.spawn` to invoke tana-local MCP tools via stdio JSON-RPC (analogous to how github-issues uses `gh` CLI)
  - `setTanaAccessor(accessor)` / `resetTanaAccessor()` — injectable setter/reset for testing
  - 10-second timeout per MCP call (NFR-1) using `AbortSignal.timeout(10_000)` or manual timer
  - Graceful error handling: MCP unavailability returns empty results / throws catchable errors (NFR-7)
  - `searchTodos()` maps to `search_nodes` with `{ and: [{ hasType: tagId }, { not: { is: 'done' } }] }`
  - `readNode()` maps to `read_node` with configurable maxDepth
  - `addChildContent()` maps to `import_tana_paste` with parentNodeId
  - `checkNode()` maps to `check_node`
- **Key Decision:** The default implementation shells out to the MCP server. In tests, it's entirely replaced by a mock. The evaluator never calls MCP directly.

### T-2.2: Create tana-todos evaluator [T]
- **File:** `src/evaluators/tana-todos.ts` (new)
- **Test:** `test/tana-todos.test.ts` (evaluator tests in T-4.1)
- **Dependencies:** T-1.1, T-1.2, T-2.1
- **Description:** Implement the core evaluator mirroring `evaluateGithubIssues()` structure:
  1. **Config parsing:** `parseTanaTodosConfig(item)` extracts tagId (required), workspaceId, limit (default 20), projectFieldId from `item.config`
  2. **Injectable dependencies** (same pattern as github-issues):
     - `setTanaBlackboardAccessor(bb)` / `resetTanaBlackboardAccessor()` — BlackboardAccessor
     - `setTanaContentFilter(fn)` / `resetTanaContentFilter()` — ContentFilterFn
     - TanaAccessor via T-2.1's setter
  3. **Evaluator flow (`evaluateTanaTodos`):**
     - Guard: check bbAccessor and tanaAccessor are set
     - Parse config; error if tagId missing
     - Call `tanaAccessor.searchTodos({ tagId, workspaceId, limit })`
     - Get existing work items and build `trackedNodeIds` Set from `source_ref` where `source = 'tana'`
     - For each todo node not in trackedNodeIds:
       - Read child content via `tanaAccessor.readNode(nodeId, 2)`
       - Concatenate child content as "instructions"
       - Run through content filter (injectable)
       - Determine content_blocked / content_warning (same logic as github-issues)
       - If projectFieldId configured, extract project name from node fields and match against blackboard projects by name
       - Create work item: `id: 'tana-<nodeId>'`, `source: 'tana'`, `sourceRef: nodeId`, `priority: 'P2'`
       - Title: node name; Description: node name + child content (with content-blocked handling)
       - Metadata: TanaWorkItemMetadata with all filter results
       - Set `minimal_context: true` if no child content
       - Set `human_review_required: true` if content blocked
     - Return `CheckResult` with status, summary, details (todosChecked, newTodos, todos array)
     - On MCP error: return `status: 'error'` with descriptive message (NFR-7)
  4. **Export:** `evaluateTanaTodos`, `parseTanaTodosConfig`, all setter/reset functions, BlackboardAccessor type (reuse from github-issues or re-define locally)

## Group 3: Integration & Wiring

### T-3.1: Register evaluator in registry [P with T-3.2]
- **File:** `src/check/evaluators.ts`
- **Dependencies:** T-2.2
- **Description:**
  - Import `evaluateTanaTodos` from `../evaluators/tana-todos.ts`
  - Add `tana_todos: evaluateTanaTodos` to the `evaluators` Record
  - Ensure import of updated `CheckType` type still works (it will, since T-1.1 added the enum value)

### T-3.2: Wire accessor in runner [P with T-3.1]
- **File:** `src/check/runner.ts`
- **Dependencies:** T-2.2
- **Description:**
  - Import `setTanaBlackboardAccessor`, `resetTanaBlackboardAccessor` from `../evaluators/tana-todos.ts`
  - Add `setTanaBlackboardAccessor(bb)` alongside existing `setBlackboardAccessor(bb)` call (line 87)
  - Add `resetTanaBlackboardAccessor()` alongside existing `resetBlackboardAccessor()` call (line 156)

### T-3.3: Add dispatch worker Tana write-back [T]
- **File:** `src/commands/dispatch-worker.ts`
- **Test:** `test/dispatch-tana.test.ts` (T-4.2)
- **Dependencies:** T-1.2, T-2.1
- **Description:** Extend the dispatch worker to handle Tana source work items:
  1. **Add `parseTanaMeta()` function** (analogous to `parseGithubMeta()` at line 23):
     ```typescript
     function parseTanaMeta(metadata: string | null): {
       isTana: boolean;
       nodeId?: string;
       workspaceId?: string;
       tagId?: string;
     }
     ```
     - Parse JSON metadata, check for `tana_node_id` field
     - Return `{ isTana: true, nodeId, workspaceId, tagId }` or `{ isTana: false }`
  2. **Add Tana write-back block** after the existing GitHub post-execution block (after line 409, before `bb.completeWorkItem`):
     - Call `parseTanaMeta(item.metadata)`
     - If `isTana === true`:
       - Import `TanaAccessor` default implementation
       - **On success (exit code 0):**
         - Build Tana Paste content: `- ✅ Ivy completed this task\n  - **Result:** [agent log summary]\n  - **Completed:** [ISO timestamp]`
         - If PR was created (from ghMeta), include PR URL
         - Call `tanaAccessor.addChildContent(nodeId, content)`
         - Call `tanaAccessor.checkNode(nodeId)`
       - **On failure (non-zero exit):**
         - Build Tana Paste content: `- ❌ Ivy encountered an error\n  - **Error:** [error description]\n  - **Attempted:** [ISO timestamp]\n  - **Status:** Task left pending for retry or manual action`
         - Call `tanaAccessor.addChildContent(nodeId, content)`
         - Do NOT call `checkNode` (leave unchecked)
       - **All write-back wrapped in try/catch** — failures are non-fatal (NFR-4)
       - Log write-back success/failure via `bb.appendEvent()`

## Group 4: Tests & Validation

### T-4.1: Evaluator unit tests [T]
- **File:** `test/tana-todos.test.ts` (new)
- **Dependencies:** T-2.1, T-2.2
- **Description:** Comprehensive tests following `test/github-issues.test.ts` patterns:
  - **Setup/teardown:** tmpDir + Blackboard + `setTanaBlackboardAccessor` + `setTanaAccessor(mockAccessor)` + `setTanaContentFilter(async () => FILTER_ALLOW)` / cleanup
  - **Helper functions:** `makeItem()` returning ChecklistItem with `type: 'tana_todos'`, `makeTanaNode()` returning TanaNode, `makeTanaNodeContent()` returning TanaNodeContent
  - **Config parsing tests:**
    - Returns defaults for empty config (limit=20, no projectFieldId)
    - Respects custom tagId, limit, workspaceId
    - Errors on missing tagId
  - **Evaluator tests:**
    - Returns error when blackboard accessor not set
    - Returns error when tana accessor not set
    - Returns ok when no todos found (empty search result)
    - Returns alert and creates work items for new todos (happy path)
    - Skips todos already tracked as work items (dedup by source_ref)
    - Second evaluator run skips already-created items (idempotent)
    - Work item has `source: 'tana'` and `sourceRef: <nodeId>`
    - Work item title from node name, description includes child content
    - Minimal context: node with no children gets `minimal_context: true` in metadata
    - Content filter: allowed content included in description
    - Content filter: blocked content excluded, description has warning, `human_review_required: true`
    - Content filter: encoding-only block includes body with warning
    - Content filter error fails open
    - Project association: matches project name from field to blackboard project
    - Project association: no match creates work item without project
    - MCP error: returns `status: 'error'` with message (graceful failure)
    - MCP timeout: accessor throws, evaluator returns error (not crash)

### T-4.2: Dispatch write-back unit tests [T]
- **File:** `test/dispatch-tana.test.ts` (new)
- **Dependencies:** T-3.3
- **Description:** Unit tests for the dispatch worker Tana integration:
  - **`parseTanaMeta` tests:**
    - Returns `{ isTana: false }` for null metadata
    - Returns `{ isTana: false }` for non-Tana metadata (e.g., GitHub)
    - Returns `{ isTana: true, nodeId, ... }` for valid Tana metadata
    - Returns `{ isTana: false }` for malformed JSON
  - **Write-back tests (mock TanaAccessor):**
    - On success: `addChildContent` called with success summary
    - On success: `checkNode` called
    - On failure: `addChildContent` called with error context
    - On failure: `checkNode` NOT called
    - Write-back failure is non-fatal: work item still completes/releases
    - Write-back event logged to blackboard

### T-4.3: Run full test suite — verify no regressions
- **Dependencies:** T-3.1, T-3.2, T-4.1, T-4.2
- **Description:** Run `bun test` across the entire project. Verify:
  - All existing tests pass (calendar, email, github-issues, specflow, etc.)
  - New tana-todos tests pass
  - New dispatch-tana tests pass
  - TypeScript compilation succeeds (`bun build` or `tsc --noEmit`)

## Execution Order

```
Phase 1 (parallel — no deps):
  T-1.1  Add tana_todos to CheckTypeSchema
  T-1.2  Create Tana types & interfaces

Phase 2 (sequential — depends on Phase 1):
  T-2.1  TanaAccessor injectable pattern
  T-2.2  tana-todos evaluator (depends on T-1.1 + T-1.2 + T-2.1)

Phase 3 (parallel — all depend on T-2.2):
  T-3.1  Register evaluator in registry
  T-3.2  Wire accessor in runner
  T-3.3  Dispatch worker write-back (depends on T-1.2 + T-2.1, parallel with T-3.1/T-3.2)

Phase 4 (tests — after implementation):
  T-4.1  Evaluator tests (after T-2.1 + T-2.2)
  T-4.2  Dispatch write-back tests (after T-3.3)
  T-4.3  Full suite regression (after all)
```

## File Summary

| File | Action | Task |
|------|--------|------|
| `src/parser/types.ts` | MODIFY — add enum value | T-1.1 |
| `src/evaluators/tana-types.ts` | CREATE | T-1.2 |
| `src/evaluators/tana-accessor.ts` | CREATE | T-2.1 |
| `src/evaluators/tana-todos.ts` | CREATE | T-2.2 |
| `src/check/evaluators.ts` | MODIFY — import + register | T-3.1 |
| `src/check/runner.ts` | MODIFY — wire accessor | T-3.2 |
| `src/commands/dispatch-worker.ts` | MODIFY — add parseTanaMeta + write-back | T-3.3 |
| `test/tana-todos.test.ts` | CREATE | T-4.1 |
| `test/dispatch-tana.test.ts` | CREATE | T-4.2 |

**Total: 4 new files, 4 modified files, 1 new test file + 1 new dispatch test file = 9 files**
