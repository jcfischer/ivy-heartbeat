# F-022: PR Merge pullMain Untracked File Conflict

## Overview

When `runPRMerge()` calls `pullMain()` after successfully merging a PR, the git pull operation fails if locally-created untracked files (e.g., spec artifacts written during the specify phase) conflict with files in the merged commit. This leaves the PR merged on GitHub but the local main branch out of sync, requiring manual intervention.

The feature adds conflict detection and cleanup before `pullMain()` attempts the pull operation, or implements graceful retry after cleanup if the initial pull fails.

## Problem Statement

**Current behavior:**
1. PR is merged via `gh pr merge --squash` (line 124, pr-merge.ts)
2. `pullMain()` is called to sync local main with merged changes (line 129 or 159)
3. If untracked files exist that conflict with incoming files, `git pull` fails
4. Error is caught, logged as non-fatal, but no recovery attempt is made
5. Local main branch remains behind remote, breaking subsequent operations

**Impact:**
- Manual git cleanup required to resolve conflicts
- Dispatch automation stalls on affected work items
- Spec artifacts risk being lost or overwritten without tracking
- Unclear repo state makes debugging difficult

## User Scenarios

### Scenario 1: Specify phase artifacts conflict with merged PR
**Given:** A SpecFlow feature has been specified, creating artifacts in `.specify/specs/f-NNN/`
**And:** The PR for this feature includes the same spec files
**And:** Local worktree has untracked spec artifacts from the specify phase
**When:** The PR is merged and `runPRMerge()` calls `pullMain()`
**Then:** Untracked spec artifacts are detected before git pull
**And:** Artifacts are stashed or cleaned up with logging
**And:** `pullMain()` completes successfully
**And:** Event log shows conflict detection and resolution actions

**Acceptance Criteria:**
- FR-1: Conflict detection runs before `pullMain()` attempts `git pull`
- FR-2: Untracked files matching `.specify/` pattern are identified
- FR-3: Cleanup strategy (stash or clean) is applied before pull
- FR-4: pullMain completes without error after cleanup
- FR-5: Event log includes conflict detection and cleanup actions

### Scenario 2: No untracked conflicts present
**Given:** A PR is merged
**And:** No untracked files exist in the local worktree
**When:** `runPRMerge()` calls `pullMain()`
**Then:** Pull operation succeeds without conflict detection overhead
**And:** Existing behavior is preserved (no regression)

**Acceptance Criteria:**
- FR-6: Fast-path check skips cleanup when no untracked files exist
- FR-7: Existing pr-merge flow unaffected by new logic

### Scenario 3: Pull fails for non-conflict reasons
**Given:** A PR is merged
**And:** Untracked files are cleaned up successfully
**When:** `pullMain()` fails due to network error or other git issue
**Then:** Error is still logged as non-fatal (preserve existing behavior)
**And:** No merge-fix work item is created for transient pull errors

**Acceptance Criteria:**
- FR-8: Non-conflict pull errors are distinguished from conflict errors
- FR-9: Existing error handling preserved for non-conflict failures
- FR-10: Event log distinguishes conflict vs non-conflict failure types

## Functional Requirements

### Core Requirements

**FR-1: Pre-pull conflict detection**
Before calling `git pull` in `pullMain()`, detect if untracked files exist that would conflict with incoming files from the merged PR.

**FR-2: Spec artifact identification**
Identify untracked files matching `.specify/specs/**/*` pattern as spec artifacts.

**FR-3: Cleanup strategy execution**
Apply one of two strategies before pull:
- **Stash:** `git stash -u` to preserve untracked files for potential recovery
- **Clean:** `git clean -fd .specify/` to remove spec artifacts (since they're in the merged PR)

**FR-4: Successful pull after cleanup**
After cleanup, `pullMain()` must complete the `git pull origin <branch>` operation without error.

**FR-5: Comprehensive event logging**
Log all conflict detection and cleanup actions to blackboard events:
- Untracked files detected (count, pattern matched)
- Cleanup strategy applied (stash or clean)
- Pull operation result (success or failure)

### Error Handling

**FR-6: Fast-path optimization**
If `git status --porcelain` shows no untracked files (`??` entries), skip cleanup and proceed directly to pull.

**FR-7: Non-regression requirement**
Existing pr-merge flow behavior must be preserved:
- Error handling pattern (try/catch, event log, non-fatal marking)
- merge-fix work item creation logic (only for genuine merge failures)
- PR state checking before recovery attempts

**FR-8: Error type discrimination**
Distinguish between:
- **Conflict errors:** "refusing to merge unrelated histories", "would be overwritten by merge"
- **Transient errors:** Network failures, auth issues, git lock files

**FR-9: Non-conflict error preservation**
Non-conflict pull errors must still log as non-fatal without triggering merge-fix recovery.

**FR-10: Diagnostic event logging**
Event metadata must include enough context for debugging:
- Error message from git stderr
- Cleanup strategy attempted (if any)
- Untracked files detected (paths or count)

## Non-Functional Requirements

**NFR-1: Performance**
Conflict detection overhead must be minimal (<500ms for typical worktree).

**NFR-2: Idempotency**
Cleanup operations must be safe to retry (e.g., stash when already clean, clean when already cleaned).

**NFR-3: Testability**
Conflict detection and cleanup logic must be unit-testable with mock git operations.

**NFR-4: Code maintainability**
Cleanup strategy must be documented in code comments, explaining when to use stash vs clean.

## Success Criteria

1. **Zero manual interventions:** PR merge → pullMain flow completes without requiring manual git cleanup
2. **Preserved spec artifacts:** No spec artifact data is lost during conflict resolution (stash preserves, clean is safe because artifacts are in merged PR)
3. **Clear diagnostics:** Event log provides sufficient context to understand what happened and why
4. **No regressions:** Existing pr-merge flow behavior unchanged for non-conflict scenarios
5. **Test coverage:** Unit tests cover conflict detection, cleanup, and retry scenarios

## Implementation Notes

### Design Decisions

**Stash vs Clean tradeoff:**
- **Stash:** Safer (preserves untracked files), but clutters stash history
- **Clean:** Simpler (removes files), but assumes artifacts are in merged PR
- **Recommended:** Clean for `.specify/` artifacts (they're in the PR), stash for other untracked files

**Conflict detection timing:**
- **Before pullMain:** Proactive detection prevents pull failure
- **After pullMain failure:** Reactive cleanup with retry
- **Recommended:** Before (fail-fast with clear error)

**Integration points:**
- `src/scheduler/worktree.ts:pullMain()` — add pre-pull conflict check
- `src/scheduler/pr-merge.ts:runPRMerge()` — may need retry logic if pull fails after cleanup

### Edge Cases

1. **Untracked files in subdirectories:** Ensure recursive detection (`git status --porcelain` shows `??` for all untracked)
2. **Empty .specify/ directory:** Clean operation must handle missing directories gracefully
3. **Stash conflicts:** If stash itself fails (rare), fall back to clean or log error
4. **Partial cleanup:** If cleanup succeeds but pull still fails, distinguish from new conflict

## Out of Scope

- Conflict resolution for tracked files (existing git merge conflict handling)
- Automatic merge conflict resolution (still requires merge-fix work item)
- Recovery of stashed files (stash exists, but no automatic pop)
- Cleanup of non-spec untracked files (focus on `.specify/` only)

## Assumptions

1. Spec artifacts are only created in `.specify/specs/` directory
2. Merged PRs include the spec artifacts from the specify phase
3. Untracked file conflicts are the primary cause of pullMain failures
4. Git stash and clean operations are reliable and available

## Related Work

- **F-021:** REFLECT phase post-merge lesson extraction (may also write to `.specify/`)
- **Issue #78:** Blackboard architecture (event logging pattern)
- **pr-merge.ts:** Existing merge flow and error handling patterns

---

[PHASE COMPLETE: SPECIFY]
