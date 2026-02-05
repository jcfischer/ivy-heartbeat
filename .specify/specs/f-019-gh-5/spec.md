# Specification: GH-5 — Tana Task Agent

## Overview

Add a new evaluator and dispatch integration that polls Tana for nodes tagged with `#ivy-todo`, converts them into blackboard work items, dispatches them through the existing agent execution pipeline, and writes results back to the originating Tana nodes upon completion.

This extends ivy-heartbeat's external integration model (currently GitHub issues only) to Tana personal knowledge management, enabling a closed-loop "todo in Tana -> work item -> agent execution -> result in Tana" workflow. The user creates tasks in their daily Tana workflow; Ivy picks them up, executes them, and reports back — all without leaving the Tana context.

## User Scenarios

### Scenario 1: New Tana Todo Detected and Ingested

- **Given** the user has created a node in Tana with the `#ivy-todo` supertag (e.g., "Fix the README typos in supertag-cli"), with child nodes providing instructions
- **And** the heartbeat checklist includes a `tana_todos` check that is enabled and due
- **When** the heartbeat evaluator runs the `tana_todos` check
- **Then** the evaluator queries Tana (via tana-local MCP) for unchecked `#ivy-todo` nodes
- **And** for each new todo not already tracked, a blackboard work item is created with `source: 'tana'` and `source_ref` set to the Tana node ID
- **And** the work item title is extracted from the node name, and the description from child content
- **And** the check result reports the count of new todos found

### Scenario 2: Dispatched Tana Work Item Completes Successfully

- **Given** a work item with `source: 'tana'` has been dispatched and the agent completed successfully
- **When** the dispatch worker finishes with exit code 0
- **Then** the originating Tana node receives a child node summarizing what was accomplished
- **And** if a PR was created, the PR URL is included in the result
- **And** the `#ivy-todo` node is checked off (marked done) in Tana
- **And** the blackboard work item is marked complete

### Scenario 3: Dispatched Tana Work Item Fails

- **Given** a work item with `source: 'tana'` has been dispatched and the agent failed
- **When** the dispatch worker finishes with a non-zero exit code or error
- **Then** the originating Tana node receives a child node describing the failure
- **And** the `#ivy-todo` node is **not** checked off (left as pending)
- **And** the blackboard work item is released back to the queue

### Scenario 4: Duplicate Prevention

- **Given** a Tana `#ivy-todo` node has already been ingested as a blackboard work item (tracked by `source_ref`)
- **When** the evaluator runs again
- **Then** the existing todo is skipped (no duplicate work item created)
- **And** the check result reflects zero new items from that node

### Scenario 5: Content Filtering on Tana Input

- **Given** a Tana `#ivy-todo` node contains content that triggers the content filter (e.g., prompt injection patterns in child nodes)
- **When** the evaluator processes this node
- **Then** the work item is created with a content-blocked warning in the description
- **And** `human_review_required` is set to `true` in the work item metadata
- **And** the content filter result is logged in metadata

### Scenario 6: Project Association via Tana Field

- **Given** a Tana `#ivy-todo` node has a "Project" field referencing a known project name
- **When** the evaluator processes this node
- **Then** the work item is associated with the matching blackboard project (by name match)
- **And** if no project match is found, the work item is created without a project association

### Scenario 7: Todo Without Sufficient Context

- **Given** a Tana `#ivy-todo` node has a name but no child nodes providing instructions
- **When** the evaluator processes this node
- **Then** a work item is still created with the node name as both title and description
- **And** the work item metadata includes `{ minimal_context: true }` to signal the agent may need to infer scope

## Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | Add `tana_todos` to `CheckTypeSchema` as a new check type | High |
| FR-2 | Create `src/evaluators/tana-todos.ts` evaluator that queries Tana MCP for unchecked `#ivy-todo` nodes | High |
| FR-3 | Register the `tana_todos` evaluator in the evaluator registry (`src/check/evaluators.ts`) | High |
| FR-4 | Extract job title from Tana node name and instructions from child node content | High |
| FR-5 | Create blackboard work items with `source: 'tana'` and `source_ref: <tana-node-id>` | High |
| FR-6 | Deduplicate against existing work items by checking `source_ref` matches | High |
| FR-7 | Run child node content through the content filter before creating work items | High |
| FR-8 | Support a configurable Tana tag ID for the `#ivy-todo` supertag in checklist item config | Medium |
| FR-9 | Support optional "Project" field on `#ivy-todo` nodes to associate work items with blackboard projects | Medium |
| FR-10 | Add Tana write-back in the dispatch worker post-execution phase for `source: 'tana'` work items | High |
| FR-11 | On success: add result summary as child node to originating Tana node, then check it off | High |
| FR-12 | On failure: add error context as child node to originating Tana node, leave unchecked | High |
| FR-13 | Parse `tana_todos` config from checklist item config fields (tag ID, polling limit, project mapping) | Medium |
| FR-14 | Provide injectable Tana accessor (like `BlackboardAccessor` pattern in github-issues) for testability | High |

## Non-Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| NFR-1 | Tana MCP calls must not block the heartbeat loop for more than 10 seconds per evaluation cycle | High |
| NFR-2 | The evaluator must be testable without a live Tana instance (injectable accessor pattern) | High |
| NFR-3 | Cost per evaluation cycle must remain under the heartbeat cost guard threshold (no additional LLM calls in the evaluator itself) | High |
| NFR-4 | Tana write-back failures must be non-fatal — the work item lifecycle completes regardless | High |
| NFR-5 | All Tana node content ingested must pass through `pai-content-filter` before agent execution | High |
| NFR-6 | Follow existing code patterns: injectable fetchers, Zod config parsing, `CheckResult` return type | Medium |
| NFR-7 | The evaluator must handle Tana MCP being unavailable gracefully (return `error` status, not crash) | High |

## Technical Context

### Existing Patterns to Follow

The `tana_todos` evaluator should mirror the architecture established by `github-issues.ts`:

1. **Injectable accessor**: A `TanaAccessor` interface with `searchNodes()`, `readNode()`, `editNode()`, `checkNode()`, and `importTanaPaste()` methods — injectable for testing
2. **Config parsing**: A `parseTanaTodosConfig()` function extracting typed config from checklist item
3. **Content filtering**: Same `ContentFilterFn` injectable pattern for testing
4. **Blackboard accessor**: Same `BlackboardAccessor` pattern for work item creation
5. **Check result**: Returns `CheckResult` with status, summary, and details

### Tana MCP Integration Points

| Operation | MCP Tool | Purpose |
|-----------|----------|---------|
| Find todos | `search_nodes` with `hasType` for ivy-todo tag | Poll for pending tasks |
| Read content | `read_node` with depth | Extract instructions from children |
| Write result | `import_tana_paste` | Add result summary as child |
| Check off | `check_node` | Mark todo as done |
| Write error | `import_tana_paste` | Add error context as child |

### Dispatch Worker Extension

The `dispatch-worker.ts` needs a new `parseTanaMeta()` function (analogous to `parseGithubMeta()`) that extracts Tana-specific metadata from work items. Post-execution, the worker should:

1. Parse Tana metadata from the completed work item
2. Write results back to the originating Tana node
3. Check off the node on success / add error on failure

### Checklist Configuration

```yaml
- name: Tana Todos
  type: tana_todos
  severity: medium
  channels: [terminal, voice]
  enabled: true
  description: Poll Tana for #ivy-todo nodes and create work items
  config:
    tag_id: "<ivy-todo-supertag-id>"
    limit: 20
    project_field_id: "<optional-project-field-id>"
```

## Success Criteria

- [ ] `tana_todos` check type is recognized and evaluatable in the heartbeat pipeline
- [ ] New `#ivy-todo` nodes in Tana are automatically ingested as blackboard work items
- [ ] Duplicate todos are not re-ingested (idempotent across evaluation cycles)
- [ ] Content filter runs on all Tana input before work item creation
- [ ] Dispatched Tana work items write results back to the originating Tana node
- [ ] Successful completions check off the `#ivy-todo` node in Tana
- [ ] Failed executions leave the todo unchecked and add error context
- [ ] Evaluator is fully testable with injected mocks (no live Tana dependency in tests)
- [ ] Tana MCP unavailability produces a graceful error, not a crash
- [ ] Existing evaluators (calendar, email, github_issues, etc.) are unaffected

## Assumptions

1. The `tana-local` MCP server is available on the local machine when the heartbeat runs (it is a dependency, not bundled)
2. The user has a Tana workspace with the `#ivy-todo` supertag already configured
3. The `#ivy-todo` supertag ID is provided via checklist config (not discovered dynamically)
4. Tana MCP operations are synchronous from the evaluator's perspective (await each call)
5. The Tana write-back in the dispatch worker can access the MCP server from the worker process context

## Open Questions

1. [TO BE CLARIFIED]: Should the `#ivy-todo` supertag schema include structured fields (Priority, Deadline, Assignee) that map to work item fields, or should those be added incrementally after the base integration works?
2. [TO BE CLARIFIED]: What is the preferred MCP invocation method from within the evaluator — direct function call via the MCP client SDK, or CLI subprocess (e.g., `bun run tana-local search_nodes ...`)? The github-issues evaluator uses `gh` CLI; the Tana equivalent would need a similar decision.
3. [TO BE CLARIFIED]: Should the evaluator support multiple Tana workspaces, or is a single workspace sufficient for the initial implementation?
