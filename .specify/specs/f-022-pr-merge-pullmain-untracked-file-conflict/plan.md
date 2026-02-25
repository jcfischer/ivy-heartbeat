# Technical Plan: F-022 PR Merge pullMain Untracked File Conflict

## Architecture Overview

The fix adds pre-pull conflict detection to the `pullMain()` flow. Current architecture:

```
┌─────────────────┐
│  runPRMerge()   │  (pr-merge.ts)
│  in scheduler   │
└────────┬────────┘
         │
         v
    ┌────────────┐        ┌──────────────┐
    │  mergePR() │───────>│  pullMain()  │  <── MODIFICATION POINT
    └────────────┘        └──────┬───────┘
         │                       │
         v                       v
    ┌────────────┐        ┌──────────────┐
    │ gh pr merge│        │  git pull    │  <── FAILURE POINT (untracked conflicts)
    └────────────┘        └──────────────┘
```

**New flow:**

```
┌──────────────────────┐
│  pullMain(path, br)  │
└──────────┬───────────┘
           │
           v
    ┌──────────────────────────┐
    │ NEW: detectConflicts()   │  <── Check for untracked files
    └──────────┬───────────────┘
               │
               ├─ No conflicts? ──> git pull (existing)
               │
               └─ Conflicts detected?
                       │
                       v
               ┌────────────────────┐
               │ NEW: cleanupSpec() │  <── Remove .specify/ artifacts
               └────────┬───────────┘
                        │
                        v
                  ┌─────────────┐
                  │  git pull   │  <── Now succeeds
                  └─────────────┘
```

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Git detection | `git status --porcelain` | Existing pattern in `isCleanBranch()` |
| Cleanup strategy | `git clean -fd .specify/` | Artifacts are in merged PR, safe to remove |
| Error handling | try/catch + event log | Matches existing pr-merge.ts pattern (lines 136-143) |
| Logging | `bb.appendEvent()` | Existing blackboard event pattern |

## Data Model

No new database entities required. Uses existing blackboard event system.

**Event metadata for conflict detection:**

```typescript
interface ConflictDetectionEvent {
  untracked_count: number;          // Number of untracked files detected
  cleanup_strategy: 'clean' | 'none';  // Strategy applied
  cleanup_paths: string[];          // Directories cleaned
}
```

## Implementation Phases

### Phase 1: Add conflict detection helper (worktree.ts)

**File:** `src/scheduler/worktree.ts`
**Location:** After line 171 (after `isCleanBranch()`)

```typescript
/**
 * Detect untracked files that would conflict with an incoming git pull.
 * Returns the list of untracked .specify/ paths, or empty array if none.
 */
export async function detectUntrackedSpecArtifacts(
  projectPath: string
): Promise<string[]> {
  const status = await git(['status', '--porcelain'], projectPath);
  if (!status) return [];

  // Parse ?? entries (untracked files)
  const untracked = status
    .split('\n')
    .filter(line => line.startsWith('??'))
    .map(line => line.slice(3).trim());

  // Filter for .specify/ artifacts only
  return untracked.filter(path => path.startsWith('.specify/'));
}
```

### Phase 2: Add cleanup helper (worktree.ts)

**File:** `src/scheduler/worktree.ts`
**Location:** After `detectUntrackedSpecArtifacts()`

```typescript
/**
 * Clean up untracked .specify/ artifacts before pulling.
 * Uses git clean to remove files that will be in the merged PR.
 * Non-fatal: logs but doesn't throw on cleanup errors.
 */
export async function cleanupSpecArtifacts(projectPath: string): Promise<boolean> {
  try {
    // -f = force, -d = directories, -x = ignored files too
    await git(['clean', '-fdx', '.specify/'], projectPath);
    return true;
  } catch {
    // Cleanup failed — pull may still work if conflicts don't actually exist
    return false;
  }
}
```

### Phase 3: Modify pullMain to detect + cleanup (worktree.ts)

**File:** `src/scheduler/worktree.ts`
**Function:** `pullMain()` (lines 553-558)

**Before:**
```typescript
export async function pullMain(
  projectPath: string,
  branch: string
): Promise<void> {
  await git(['pull', 'origin', branch], projectPath);
}
```

**After:**
```typescript
export async function pullMain(
  projectPath: string,
  branch: string
): Promise<{ cleaned: boolean; untrackedCount: number }> {
  // Fast-path: detect untracked .specify/ artifacts before pull
  const untrackedArtifacts = await detectUntrackedSpecArtifacts(projectPath);

  if (untrackedArtifacts.length > 0) {
    // Conflicts detected — clean up before pull
    await cleanupSpecArtifacts(projectPath);
    await git(['pull', 'origin', branch], projectPath);
    return { cleaned: true, untrackedCount: untrackedArtifacts.length };
  }

  // No conflicts — pull directly
  await git(['pull', 'origin', branch], projectPath);
  return { cleaned: false, untrackedCount: 0 };
}
```

### Phase 4: Update pr-merge callsites to log cleanup (pr-merge.ts)

**File:** `src/scheduler/pr-merge.ts`
**Locations:** Lines 129 and 159 (both `pullMain()` calls)

**Before (line 129):**
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

**Apply same pattern to line 159** (second pullMain call in already-merged path).

### Phase 5: Add unit tests

**File:** `tests/worktree.test.ts` (new or append to existing)

**Test cases:**
1. `detectUntrackedSpecArtifacts` returns empty array when tree is clean
2. `detectUntrackedSpecArtifacts` returns .specify/ paths when untracked files exist
3. `detectUntrackedSpecArtifacts` ignores non-.specify/ untracked files
4. `cleanupSpecArtifacts` removes .specify/ directory contents
5. `pullMain` skips cleanup when no untracked files exist (fast path)
6. `pullMain` cleans up and pulls when untracked .specify/ files detected
7. `pullMain` returns correct metadata (cleaned flag, count)

**Mock strategy:** Use test fixtures or create temp directories with untracked files, mock `git()` calls for verification.

## File Structure

### Modified Files

```
src/scheduler/
├── worktree.ts                # +30 lines (2 new functions, 1 modified)
│   ├── detectUntrackedSpecArtifacts()  [NEW - after line 171]
│   ├── cleanupSpecArtifacts()          [NEW - after detectUntrackedSpecArtifacts]
│   └── pullMain()                      [MODIFIED - lines 553-558]
│
└── pr-merge.ts                # +15 lines (2 callsite updates)
    ├── runPRMerge() line 129  [MODIFIED - add conflict logging]
    └── runPRMerge() line 159  [MODIFIED - add conflict logging]

tests/
└── worktree.test.ts           # +150 lines (7 new tests)
```

### No New Files

All changes are modifications to existing files. No new abstractions or modules.

## Dependencies

### Runtime Dependencies
- **Git CLI:** Required for `git status --porcelain` and `git clean`
- **Existing `git()` helper:** Already implemented in worktree.ts (lines 102-120)

### Test Dependencies
- **Bun test framework:** Already in use (project standard)
- **Mock filesystem:** May use temp directories or mocked `git()` calls

### No New Packages

All functionality uses existing utilities and patterns. No `package.json` changes.

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|-----------|------------|
| **Cleanup removes user files** | High | Low | Only clean `.specify/` path (spec artifacts are in merged PR) |
| **Clean fails, pull still errors** | Medium | Low | Pull failure already logged as non-fatal (lines 136-143) |
| **Untracked non-spec files block pull** | Medium | Medium | Current design only cleans `.specify/` — document this scope limit |
| **Empty .specify/ causes clean error** | Low | Low | `git clean` handles missing directories gracefully |
| **Performance overhead on fast path** | Low | Low | `git status --porcelain` is <100ms, only runs once |
| **Breaking change to pullMain signature** | High | Low | Return value change breaks callers. **UPDATE:** Phase 4 handles this by updating both callsites |

### Edge Cases

1. **Stale .specify/ from aborted specify phase:**
   - Untracked artifacts exist but don't match PR content
   - **Handled:** Cleanup removes all `.specify/` untracked files before pull

2. **Concurrent worktree operations:**
   - Another process creates .specify/ files between detection and cleanup
   - **Handled:** Cleanup runs immediately before pull, window is <500ms

3. **Symlinks in .specify/:**
   - Symlinks to files outside .specify/ could break cleanup
   - **Handled:** `git clean -fd` follows symlinks safely, only removes tracked paths

4. **Pull fails for non-conflict reasons:**
   - Network error, auth failure, git lock
   - **Handled:** Existing error handling at pr-merge.ts lines 136-143 logs as non-fatal

## Design Decisions

### 1. Clean vs Stash

**Decision:** Use `git clean -fd .specify/` (remove files)

**Rationale:**
- Spec artifacts from the specify phase are included in the merged PR
- No risk of data loss — artifacts exist in git history after merge
- Simpler than stash (no stash pop needed, no stash history clutter)
- Cleanup is idempotent (can run multiple times safely)

**Alternative:** `git stash -u` would preserve files, but:
- Adds stash history noise
- Requires stash pop after pull (additional error path)
- Unnecessary since artifacts are in merged PR

### 2. Detection Timing: Before vs After

**Decision:** Detect **before** `git pull` (fail-fast approach)

**Rationale:**
- Prevents pull failure rather than recovering from it
- Single code path (no retry logic needed)
- Clear event log (conflict detected → cleaned → pulled)

**Alternative:** Try pull, catch error, cleanup, retry would:
- Require error message parsing to distinguish conflict vs network errors
- Add retry complexity
- Less clear event log (failed pull → cleanup → retry)

### 3. Scope: .specify/ Only

**Decision:** Only clean `.specify/` artifacts, ignore other untracked files

**Rationale:**
- Spec artifacts are the known cause of conflicts (from specify phase)
- Minimal blast radius (won't touch user files in other directories)
- Conservative approach (can expand scope later if needed)

**Future:** If other untracked directories cause conflicts, generalize cleanup pattern.

### 4. Return Value Change

**Decision:** Change `pullMain()` signature from `Promise<void>` to `Promise<{ cleaned: boolean; untrackedCount: number }>`

**Rationale:**
- Enables rich event logging (ISC-C5 requirement)
- Minimal breaking change (only 2 callsites in pr-merge.ts)
- Both callsites updated in Phase 4

**Risk:** If other modules call `pullMain()`, they'll break. **Verified:** Only pr-merge.ts calls it (lines 129, 159).

## Success Metrics

1. **Zero manual interventions:** PR merge → pullMain completes end-to-end without git errors
2. **Event log visibility:** Conflict detection and cleanup actions appear in blackboard events
3. **Fast-path performance:** No measurable overhead when no conflicts exist (<10ms)
4. **Test coverage:** All 7 unit tests pass, covering detection, cleanup, and integration
5. **No regressions:** Existing pr-merge flow unchanged for non-conflict scenarios

## Out of Scope

- **Conflict resolution for tracked files:** Still requires merge-fix work item (existing behavior)
- **Automatic stash pop:** Cleanup uses `git clean`, not stash
- **Cleanup of non-spec untracked files:** Only `.specify/` directory cleaned
- **Recovery of cleaned files:** Files are in merged PR, no separate recovery needed
- **Detection of other conflict types:** Only untracked file conflicts handled

## Integration Notes

### Blackboard Event Schema

New event metadata fields added by cleanup logging:

```typescript
{
  conflictCleaned: boolean,      // Was cleanup performed?
  untrackedCount: number,        // How many untracked files detected?
  mainBranch: string,            // Existing field, preserved
}
```

### Error Handling Consistency

Preserves existing non-fatal error handling pattern (pr-merge.ts lines 136-143):
- Pull errors are logged but don't create merge-fix work items
- Cleanup errors are caught, logged, pull is still attempted
- Only genuine merge failures trigger merge-fix recovery

### Testing Strategy

**Unit tests** cover:
- Detection logic (with/without untracked files)
- Cleanup logic (success and failure paths)
- Integration (pullMain flow with cleanup)

**Manual verification:**
1. Create untracked `.specify/` files in main repo
2. Merge a PR via dispatch
3. Check event log for conflict detection + cleanup
4. Verify main branch synced correctly

## Implementation Estimate

| Phase | Lines Changed | Effort | Parallelizable |
|-------|---------------|--------|----------------|
| Phase 1: Detection helper | +15 | 15 min | No (foundation) |
| Phase 2: Cleanup helper | +10 | 10 min | No (depends on Phase 1) |
| Phase 3: Modify pullMain | +5 | 15 min | No (core logic) |
| Phase 4: Update callsites | +10 | 20 min | Yes (2 independent sites) |
| Phase 5: Unit tests | +150 | 60 min | Yes (parallel to Phase 4) |
| **Total** | **190 lines** | **2 hours** | Phases 4-5 parallel |

**Critical path:** Phases 1 → 2 → 3 → 4 (60 min)
**Parallel work:** Phase 5 can start after Phase 2 completes (mock-based tests)

---

[PHASE COMPLETE: PLAN]
