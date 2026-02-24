# Implementation Tasks: F-020 PR Review Feedback Loop

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | ☐ | Comment parsing module |
| T-1.2 | ☐ | Comment parsing tests |
| T-2.1 | ☐ | Idempotency check |
| T-2.2 | ☐ | Inline comments in metadata |
| T-2.3 | ☐ | Enhanced rework prompt |
| T-2.4 | ☐ | Configurable max cycles |
| T-3.1 | ☐ | ensureBranch helper |
| T-3.2 | ☐ | Worktree reuse logic |
| T-4.1 | ☐ | Metadata chain in dispatch |
| T-4.2 | ☐ | Escalation enhancement |
| T-5.1 | ☐ | Rework unit tests |
| T-5.2 | ☐ | Integration test |

---

## Group 1: Foundation — Comment Parsing Module

### T-1.1: Create PR comment fetching module [T]
- **File:** src/scheduler/pr-comments.ts
- **Test:** tests/pr-comments.test.ts
- **Dependencies:** none
- **Description:** Create new module with `fetchPRComments()` and `formatCommentsForPrompt()` functions. Use `Bun.spawn` to call `gh api repos/{owner}/{repo}/pulls/{pr}/reviews` and `gh api repos/{owner}/{repo}/pulls/{pr}/comments`. Implement 30-second timeout via AbortController. Define `InlineComment` interface with `path`, `line`, `body`, `author`, `created_at` fields. Export formatted prompt section generation. (~100 lines)

### T-1.2: Add comment parsing tests [T] [P with T-2.1]
- **File:** tests/pr-comments.test.ts
- **Test:** (self)
- **Dependencies:** T-1.1
- **Description:** Mock `Bun.spawn` to simulate `gh api` responses. Test timeout enforcement (mock slow response, verify abort). Test comment parsing with various formats (reviews, inline comments). Test formatting for prompt output with file paths and line numbers. (~120 lines)

---

## Group 2: Core Logic — Rework Enhancement

### T-2.1: Add idempotency check to createReworkWorkItem [T]
- **File:** src/scheduler/rework.ts
- **Test:** tests/rework.test.ts
- **Dependencies:** none
- **Description:** Before creating a new rework work item, check for existing pending rework items for the same PR and rework_cycle. If found, return existing item_id instead of creating duplicate. Use `bb.listWorkItems({ status: 'pending' })` with metadata filter. (~15 lines addition)

### T-2.2: Add inline comments to ReworkMetadata [T] [P with T-2.1]
- **File:** src/scheduler/rework.ts
- **Test:** tests/rework.test.ts
- **Dependencies:** T-1.1
- **Description:** Extend `ReworkMetadata` interface with `worktree_path?: string`, `inline_comments?: InlineComment[]`, and `max_rework_cycles?: number` fields. In `createReworkWorkItem()`, call `fetchPRComments()` and attach parsed comments to metadata. (~20 lines addition)

### T-2.3: Enhance buildReworkPrompt with inline comments [T]
- **File:** src/scheduler/rework.ts
- **Test:** tests/rework.test.ts
- **Dependencies:** T-2.2
- **Description:** Modify `buildReworkPrompt()` to include structured inline comments section. Format each comment with file path, line number, and body. Add clear instruction: "Address each comment above specifically." (~30 lines modification)

### T-2.4: Add configurable max rework cycles [T]
- **File:** src/scheduler/rework.ts
- **Test:** tests/rework.test.ts
- **Dependencies:** T-2.1
- **Description:** Read `max_rework_cycles` from project metadata (via `bb.getProject(projectId)?.metadata`). Default to 2 per spec. Pass through metadata chain. Check cycle count before creating rework items. (~15 lines modification)

---

## Group 3: Worktree Management

### T-3.1: Add ensureBranch helper to worktree.ts [T]
- **File:** src/scheduler/worktree.ts
- **Test:** tests/worktree.test.ts
- **Dependencies:** none
- **Description:** Create `ensureBranch(worktreePath: string, branch: string)` function that verifies the worktree is on the correct branch. If not, checkout the branch. Handle errors gracefully (branch not found, uncommitted changes). (~25 lines)

### T-3.2: Implement worktree reuse in runRework [T]
- **File:** src/scheduler/rework.ts
- **Test:** tests/rework.test.ts
- **Dependencies:** T-3.1, T-2.2
- **Description:** Modify `runRework()` to check `meta.worktree_path` first. If path exists and is valid, reuse it (call `ensureBranch`). If path missing or invalid, fall back to creating new worktree. Log event indicating reuse or fallback. (~40 lines modification)

---

## Group 4: Integration — Metadata Chain & Escalation

### T-4.1: Pass worktree_path through dispatch metadata chain [T]
- **File:** src/commands/dispatch-worker.ts
- **Test:** tests/dispatch-worker.test.ts
- **Dependencies:** T-2.2
- **Description:** When implement phase creates a worktree, store the path in work item metadata. When creating `code_review` work items, copy `worktree_path` from implement metadata. When creating rework items, preserve `worktree_path` from code_review metadata. (~20 lines across functions)

### T-4.2: Enhance escalation with human_review_required flag [T]
- **File:** src/scheduler/rework.ts
- **Test:** tests/rework.test.ts
- **Dependencies:** T-2.4
- **Description:** When `rework_cycle > max_rework_cycles`, mark the original implementation work item with `human_review_required: true` and `escalation_reason`. Emit blackboard event with escalation details. Return null instead of creating new rework item. (~20 lines modification)

---

## Group 5: Testing & Verification

### T-5.1: Add rework.test.ts test cases [T]
- **File:** tests/rework.test.ts
- **Test:** (self)
- **Dependencies:** T-2.1, T-2.2, T-2.3, T-2.4, T-3.2, T-4.2
- **Description:** Add test cases for: (1) idempotency — calling `createReworkWorkItem` twice returns same ID, (2) worktree reuse — valid path reused, missing path falls back, (3) configurable max cycles — project metadata overrides default, (4) escalation — `human_review_required` set on original item, (5) inline comments included in metadata and prompt. (~80 lines)

### T-5.2: Add integration test for full feedback loop [T]
- **File:** tests/feedback-loop.integration.test.ts
- **Test:** (self)
- **Dependencies:** T-5.1, all prior tasks
- **Description:** End-to-end test: mock review-agent emitting `work_rejected` → rework item created → rework agent runs → re-review item created. Verify metadata chain preserves `worktree_path`. Verify max cycles reached triggers escalation event. (~60 lines)

---

## Execution Order

1. **Parallel batch 1:** T-1.1, T-2.1, T-3.1 (no dependencies)
2. **Parallel batch 2:** T-1.2, T-2.2 (after T-1.1 / can parallel with T-2.1 completion)
3. **Sequential:** T-2.3 (after T-2.2)
4. **Parallel batch 3:** T-2.4, T-3.2 (after dependencies met)
5. **Sequential:** T-4.1 (after T-2.2)
6. **Sequential:** T-4.2 (after T-2.4)
7. **Sequential:** T-5.1 (after all core tasks)
8. **Final:** T-5.2 (after T-5.1)

---

## Files Summary

### Files to Create
| File | Task | Lines (est.) |
|------|------|--------------|
| `src/scheduler/pr-comments.ts` | T-1.1 | ~100 |
| `tests/pr-comments.test.ts` | T-1.2 | ~120 |
| `tests/feedback-loop.integration.test.ts` | T-5.2 | ~60 |

### Files to Modify
| File | Tasks | Changes |
|------|-------|---------|
| `src/scheduler/rework.ts` | T-2.1, T-2.2, T-2.3, T-2.4, T-3.2, T-4.2 | +~140 lines |
| `src/scheduler/worktree.ts` | T-3.1 | +~25 lines |
| `src/commands/dispatch-worker.ts` | T-4.1 | +~20 lines |
| `tests/rework.test.ts` | T-5.1 | +~80 lines |

### Files NOT Modified (per NFR-1)
| File | Reason |
|------|--------|
| `src/scheduler/review-agent.ts` | Already emits `work_rejected` event — no changes needed |

---

## FR Traceability

| FR | Covered By |
|----|-----------|
| FR-1: Work item source | T-2.2 (ReworkMetadata extension) |
| FR-2: Feedback evaluator | Existing review-agent.ts (no changes) |
| FR-3: Fix agent prompt | T-2.3 (buildReworkPrompt enhancement) |
| FR-4: Fix agent execution | T-3.2 (worktree reuse) |
| FR-5: Max fix cycles | T-2.4, T-4.2 (configurable, escalation) |
| FR-6: Re-review work item | Existing flow (unchanged) |
| FR-7: Worktree reuse | T-3.1, T-3.2, T-4.1 |
| FR-8: Comment parsing | T-1.1, T-1.2 |
