# F-020: PR Review Feedback Loop

## Overview

### Problem Statement

ivy-heartbeat's review agent (`review-agent.ts`) posts structured AI code reviews on PRs — either approving or requesting changes. When changes are requested, the PR sits in `changes_requested` state with no automated follow-up. The developer (or the original implement agent) must manually read the review comments, fix the issues, push updates, and re-request review. For autonomous SpecFlow features where no human developer is involved, this means PRs with `changes_requested` reviews stall indefinitely.

### Solution Summary

A new feedback-loop stage in the dispatch pipeline that:
1. **Detects** PRs with `changes_requested` review status (via blackboard events or work item metadata)
2. **Parses** the review comments from the PR using `gh pr view` / `gh api`
3. **Dispatches** a fix agent into the original worktree with a prompt containing the review feedback
4. **Pushes** the fixes and re-requests review by creating a new `code_review` work item
5. **Limits** the loop to a configurable max (default: 2 fix cycles) to prevent infinite churn
6. **Escalates** to human review when the max is exceeded

### Approach

**Event-Driven Fix Dispatch (integrated with existing pipeline)**

When the review agent completes with `changes_requested`, it already emits a `work_rejected` event on the blackboard. The feedback loop hooks into this event:

```
[review agent posts changes_requested]
    ↓ emits work_rejected event
[feedback evaluator detects work_rejected + fix_cycle < max]
    ↓ creates fix work item
[dispatch worker picks up fix work item]
    ↓ runs fix agent in original worktree
[fix agent reads comments, fixes code, commits, pushes]
    ↓ creates new code_review work item
[review agent reviews updated PR]
    ↓ approved → done  |  changes_requested → loop (if under max)
```

## User Scenarios

### US-1: Automatic Fix After Review Rejection

**Given** the review agent has posted a `changes_requested` review on PR #42 in `owner/repo`
**And** the work item metadata has `fix_cycle: 0` (or no fix_cycle field)
**When** the feedback evaluator runs during the next heartbeat check
**Then** a new work item is created with `source: 'review_fix'` containing the review comments as context
**And** the fix agent is dispatched into the original worktree for the PR branch
**And** the fix agent reads the review comments, applies fixes, commits, and pushes

### US-2: Re-Review After Fix

**Given** a fix agent has successfully pushed changes to the PR branch
**When** the fix work item completes
**Then** a new `code_review` work item is created for the same PR
**And** the review agent runs again on the updated diff
**And** the `fix_cycle` counter is incremented in the work item metadata

### US-3: Max Fix Cycles Exceeded — Human Escalation

**Given** a PR has already gone through 2 fix cycles (configurable max)
**And** the review agent still requests changes
**When** the feedback evaluator detects the `work_rejected` event
**Then** no new fix work item is created
**And** the work item is marked with `human_review_required: true` in metadata
**And** a blackboard event is emitted: "Max fix cycles exceeded — escalating to human review"

### US-4: Fix Agent Uses Review Comments as Context

**Given** a fix work item is dispatched for PR #42
**When** the fix agent starts
**Then** the agent prompt includes:
  - The original spec/plan context (from the `.specify/` directory)
  - The full review comment body from the `changes_requested` review
  - Individual file-level comments from the PR
  - Instructions to address each comment specifically

### US-5: No Loop on Approved PRs

**Given** the review agent approves PR #42
**When** the feedback evaluator checks for `work_rejected` events
**Then** no fix work item is created
**And** the pipeline proceeds to completion normally

## Functional Requirements

### FR-1: Review Fix Work Item Source

The system MUST support a new work item source `review_fix` alongside existing `github`, `specflow`, and `code_review` sources. Fix work items carry metadata:

```typescript
interface ReviewFixMetadata {
  pr_number: number;
  repo: string;               // "owner/repo"
  branch: string;             // PR head branch
  worktree_path: string;      // original worktree (reused)
  fix_cycle: number;          // 0-based counter
  max_fix_cycles: number;     // configurable limit (default: 2)
  review_comments: string;    // serialized review feedback
  implementation_work_item_id: string;  // original implement work item
  project_id: string;
}
```

### FR-2: Feedback Evaluator

A new evaluator (or extension to an existing one) MUST detect `work_rejected` events on code review work items and:

1. Parse the review metadata from the event or work item
2. Check `fix_cycle < max_fix_cycles`
3. If under limit: fetch full review comments via `gh api repos/{owner}/{repo}/pulls/{pr}/reviews` and `gh api repos/{owner}/{repo}/pulls/{pr}/comments`
4. Create a `review_fix` work item with the review context
5. If at limit: mark the work item with `human_review_required: true` and emit an escalation event

### FR-3: Fix Agent Prompt

The fix agent prompt MUST include:

1. The original spec/plan/tasks context (if available from `.specify/` directory)
2. The review summary from the `changes_requested` review body
3. Individual file-level review comments with file paths and line numbers
4. Clear instructions: "Address each review comment. Do not modify code unrelated to the review feedback."
5. Instructions to commit and push (not create a new PR — the branch already has one)

### FR-4: Fix Agent Execution

The dispatch worker MUST handle `source === 'review_fix'` work items by:

1. Validating the worktree still exists at the metadata path
2. Running the fix agent in the existing worktree (no new worktree creation)
3. After agent completes: checking for git changes via `git diff`
4. If changes present: commit with message referencing the review, push to branch
5. On success: create a new `code_review` work item for re-review with `fix_cycle` incremented
6. On failure (no changes or agent error): emit failure event, do not retry

### FR-5: Max Fix Cycles

The system MUST enforce a configurable maximum number of fix cycles:

- Default: 2 (configurable via checklist item config `max_fix_cycles`)
- When exceeded: mark work item metadata with `human_review_required: true`
- Emit blackboard event: "PR #{number} exceeded max fix cycles ({max}) — requires human review"
- Do NOT create additional fix or review work items

### FR-6: Re-Review Work Item Creation

After a successful fix push, the system MUST create a new `code_review` work item that:

- References the same PR number and repo
- Carries the incremented `fix_cycle` count
- Links to the original `implementation_work_item_id`
- Uses the existing review-agent flow (no changes to `review-agent.ts`)

### FR-7: Worktree Reuse

Fix agents MUST reuse the original implementation worktree:

- The worktree path is stored in the work item metadata chain
- If the worktree has been cleaned up (staleness TTL), the fix work item fails gracefully
- No new worktrees are created for review fixes

### FR-8: Comment Parsing

The system MUST parse PR review comments using the GitHub API:

- `gh api repos/{owner}/{repo}/pulls/{pr}/reviews` for review bodies
- `gh api repos/{owner}/{repo}/pulls/{pr}/comments` for file-level inline comments
- Comments are serialized into the fix agent prompt with file paths and context

## Non-Functional Requirements

### NFR-1: No Breaking Changes to Review Agent

The review-agent.ts module MUST NOT require modifications. The feedback loop hooks into the existing `work_rejected` event pattern. The review agent's output format (`REVIEW_RESULT`, `FINDINGS_COUNT`, `SEVERITY`, `SUMMARY`) remains unchanged.

### NFR-2: Idempotency

If the feedback evaluator runs multiple times before a fix agent is dispatched, it MUST NOT create duplicate fix work items. Check for existing `review_fix` work items for the same PR before creating new ones.

### NFR-3: Performance

- Comment fetching via `gh api` MUST complete within 30 seconds
- Fix agent dispatch MUST follow the same timeout as implement agents (configurable, default 10 minutes)
- No additional polling — the evaluator runs on the existing heartbeat cycle

### NFR-4: Observability

All feedback loop actions MUST be logged as blackboard events:
- Fix work item creation with review context summary
- Fix agent completion (success/failure)
- Re-review work item creation
- Max cycle exceeded escalation

## Success Criteria

| Criterion | Measurement |
|-----------|-------------|
| End-to-end loop works | A PR with `changes_requested` automatically gets fixes pushed and re-reviewed |
| Max cycles enforced | After N fix cycles, the loop stops and marks `human_review_required` |
| Review comments parsed | Fix agent prompt contains actual review feedback from the PR |
| No review-agent changes | `review-agent.ts` remains unmodified |
| Worktree reused | Fix agent operates in the original worktree, no new worktrees |
| Idempotent | Multiple evaluator runs don't create duplicate fix work items |

## Assumptions

- The `gh` CLI is authenticated and available on the system
- Review comments are accessible via `gh api` (no private/restricted PRs)
- The original worktree persists long enough for the fix cycle (within staleness TTL)
- The review agent's `changes_requested` review provides actionable, specific feedback

## Out of Scope

- **Interactive fix sessions** — the fix agent runs autonomously, no human-in-the-loop during fixes
- **Partial comment addressing** — the fix agent attempts all comments; selective addressing requires human judgment
- **Cross-PR dependencies** — each PR's feedback loop is independent
- **Review comment threading** — only top-level review comments and file-level comments are parsed; reply threads are not followed
- **Modifying the review agent's review dimensions** — the 6-dimension review framework stays as-is
