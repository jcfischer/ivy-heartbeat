# Implementation Tasks: F-022 PR Merge pullMain Untracked File Conflict

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | ☐ | |
| T-1.2 | ☐ | |
| T-2.1 | ☐ | |
| T-2.2 | ☐ | |
| T-3.1 | ☐ | |
| T-3.2 | ☐ | |
| T-4.1 | ☐ | |

## Group 1: Foundation - Detection & Cleanup Helpers

### T-1.1: Add detectUntrackedSpecArtifacts helper [T]
- **File:** src/scheduler/worktree.ts (after line 171, after `isCleanBranch()`)
- **Test:** tests/worktree.test.ts
- **Dependencies:** none
- **Description:** Implement `detectUntrackedSpecArtifacts(projectPath)` function that runs `git status --porcelain`, parses `??` entries, and filters for `.specify/` paths. Returns string array of untracked spec artifact paths.

**Implementation details:**
- Use existing `git()` helper (lines 102-120)
- Parse status output line-by-line
- Filter lines starting with `??`
- Return only paths starting with `.specify/`

**Tests:**
- Empty array when tree is clean
- Returns .specify/ paths when untracked files exist
- Ignores non-.specify/ untracked files

### T-1.2: Add cleanupSpecArtifacts helper [T]
- **File:** src/scheduler/worktree.ts (after `detectUntrackedSpecArtifacts()`)
- **Test:** tests/worktree.test.ts
- **Dependencies:** none (can run in parallel with T-1.1)
- **Description:** Implement `cleanupSpecArtifacts(projectPath)` function that runs `git clean -fdx .specify/` to remove untracked spec artifacts. Returns boolean indicating success. Non-fatal errors caught and logged.

**Implementation details:**
- Use `git()` helper with `['clean', '-fdx', '.specify/']`
- Wrap in try/catch
- Return true on success, false on error
- Non-throwing (errors are logged but don't propagate)

**Tests:**
- Successfully removes .specify/ directory contents
- Returns true on success
- Returns false on git clean failure
- Handles missing .specify/ directory gracefully

## Group 2: Core - Modify pullMain

### T-2.1: Change pullMain signature [T]
- **File:** src/scheduler/worktree.ts (lines 553-558)
- **Test:** tests/worktree.test.ts
- **Dependencies:** T-1.1, T-1.2
- **Description:** Modify `pullMain()` to return `Promise<{ cleaned: boolean; untrackedCount: number }>` instead of `Promise<void>`. Add conflict detection before pull using `detectUntrackedSpecArtifacts()`. If conflicts exist, call `cleanupSpecArtifacts()` before pull.

**Implementation details:**
- Call `detectUntrackedSpecArtifacts()` first
- If array.length > 0, call `cleanupSpecArtifacts()` then pull
- If array.length === 0, pull directly (fast path)
- Return object with `cleaned` flag and `untrackedCount`

**Tests:**
- Fast path: no untracked files → pull directly, return { cleaned: false, untrackedCount: 0 }
- Conflict path: untracked .specify/ detected → cleanup → pull, return { cleaned: true, untrackedCount: N }
- Verify cleanup called before pull when conflicts exist

### T-2.2: Update pullMain JSDoc [P with T-2.1]
- **File:** src/scheduler/worktree.ts (lines 553-558)
- **Test:** none (documentation only)
- **Dependencies:** T-2.1
- **Description:** Add JSDoc comment to `pullMain()` explaining return value structure and conflict detection behavior.

**Implementation details:**
```typescript
/**
 * Pull latest changes from remote branch into local repository.
 * Detects and cleans up untracked .specify/ artifacts before pull to prevent conflicts.
 * @returns Object with cleanup metadata: cleaned (boolean), untrackedCount (number)
 */
```

## Group 3: Integration - Update pr-merge Callsites

### T-3.1: Update first pullMain callsite (line 129) [T] [P with T-3.2]
- **File:** src/scheduler/pr-merge.ts (line 129)
- **Test:** tests/pr-merge.test.ts (or integration test)
- **Dependencies:** T-2.1
- **Description:** Update `pullMain()` call at line 129 to capture return value and log conflict cleanup metadata to blackboard event. Preserve existing event structure, add new metadata fields: `conflictCleaned`, `untrackedCount`.

**Before:**
```typescript
await pullMain(project.local_path, meta.main_branch);
bb.appendEvent({
  actorId: sessionId,
  targetId: item.item_id,
  summary: `Pulled merged changes from PR #${meta.pr_number} into ${meta.main_branch}`,
  metadata: { mainBranch: meta.main_branch },
});
```

**After:**
```typescript
const pullResult = await pullMain(project.local_path, meta.main_branch);
bb.appendEvent({
  actorId: sessionId,
  targetId: item.item_id,
  summary: pullResult.cleaned
    ? `Cleaned ${pullResult.untrackedCount} untracked spec artifacts before pull from PR #${meta.pr_number}`
    : `Pulled merged changes from PR #${meta.pr_number} into ${meta.main_branch}`,
  metadata: {
    mainBranch: meta.main_branch,
    conflictCleaned: pullResult.cleaned,
    untrackedCount: pullResult.untrackedCount,
  },
});
```

**Tests:**
- Event log includes `conflictCleaned: true` when cleanup performed
- Event summary reflects cleanup action when cleaned
- Event log includes `untrackedCount` metadata

### T-3.2: Update second pullMain callsite (line 159) [T] [P with T-3.1]
- **File:** src/scheduler/pr-merge.ts (line 159)
- **Test:** tests/pr-merge.test.ts (or integration test)
- **Dependencies:** T-2.1
- **Description:** Apply same update pattern as T-3.1 to second `pullMain()` call at line 159 (already-merged path). Capture return value and log conflict metadata to blackboard event.

**Implementation:** Same transformation as T-3.1 but at different callsite location.

**Tests:**
- Same test coverage as T-3.1 for second callsite

## Group 4: Testing

### T-4.1: Add unit tests for conflict detection flow [T]
- **File:** tests/worktree.test.ts
- **Test:** self (this is the test task)
- **Dependencies:** T-1.1, T-1.2, T-2.1
- **Description:** Comprehensive unit tests covering all conflict detection and cleanup scenarios. Mock `git()` calls for isolation.

**Test cases:**
1. `detectUntrackedSpecArtifacts` returns empty array when tree is clean
2. `detectUntrackedSpecArtifacts` returns .specify/ paths when untracked files exist
3. `detectUntrackedSpecArtifacts` ignores non-.specify/ untracked files
4. `cleanupSpecArtifacts` removes .specify/ directory contents
5. `pullMain` skips cleanup when no untracked files exist (fast path)
6. `pullMain` cleans up and pulls when untracked .specify/ files detected
7. `pullMain` returns correct metadata (cleaned flag, untrackedCount)

**Mock strategy:**
- Mock `git()` calls to simulate status and clean operations
- Use test fixtures for git status output parsing
- Verify git clean called with correct arguments when conflicts exist

## Execution Order

### Critical Path (60 min)
1. **T-1.1** (15 min) - Detection helper (foundation)
2. **T-1.2** (10 min) - Cleanup helper (can run parallel with T-1.1, but listed sequentially for clarity)
3. **T-2.1** (15 min) - Modify pullMain core logic
4. **T-3.1** (10 min) - Update first callsite
5. **T-3.2** (10 min) - Update second callsite

### Parallel Opportunities
- **T-1.1 ∥ T-1.2** - Both helpers are independent, can be developed simultaneously
- **T-3.1 ∥ T-3.2** - Both callsite updates are identical patterns, can be done in parallel
- **T-4.1** - Can start after T-1.2 completes (mock-based tests don't need T-2.1 or T-3.x)

### Recommended Sequence
1. Start: T-1.1, T-1.2 (parallel)
2. Wait for T-1.1, T-1.2 → Start: T-2.1
3. Wait for T-2.1 → Start: T-3.1, T-3.2 (parallel)
4. T-4.1 can run anytime after T-1.2 (early start recommended)

## Summary

**Total tasks:** 7
**Parallelizable:** 4 (T-1.2 with T-1.1, T-3.1 with T-3.2, T-4.1 after T-1.2)
**Estimated effort:** 2 hours
**Critical path:** T-1.1 → T-2.1 → T-3.1 (40 min)
**Files modified:** 2 (worktree.ts, pr-merge.ts)
**Test files:** 1 (worktree.test.ts)
**Lines added:** ~190 total
