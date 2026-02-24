# Technical Plan: F-020 PR Review Feedback Loop

## Architecture Overview

F-020 enhances the **existing** rework system (`rework.ts`) rather than creating a parallel feedback mechanism. The current architecture already implements most of the required flow:

```
┌────────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  review-agent.ts   │────>│    rework.ts     │────>│ dispatch-worker.ts  │
│ (dispatches review)│     │ (creates rework  │     │ (runs rework agent) │
│                    │     │  work item)      │     │                     │
└────────────────────┘     └──────────────────┘     └─────────────────────┘
         │                         │                         │
         │ changes_requested       │ source='rework'         │ on success
         ▼                         ▼                         ▼
┌────────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   work_rejected    │     │  ReworkMetadata  │     │  code_review work   │
│   event emitted    │     │  with feedback   │     │  item for re-review │
└────────────────────┘     └──────────────────┘     └─────────────────────┘
```

**Key insight:** The spec's `review_fix` source type maps directly to the existing `rework` source. Rather than adding a parallel system, we enhance `rework.ts` with:
1. Detailed PR comment parsing (not just summary)
2. Configurable max cycles (spec default: 2 vs current hardcoded 3)
3. Enhanced escalation with `human_review_required` metadata flag
4. Idempotency checks before creating rework items
5. Worktree path persistence in metadata chain

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Comment fetching | `gh api` via `Bun.spawn` | Already used elsewhere; respects 30s timeout via AbortController |
| Rework orchestration | Enhanced `rework.ts` | Builds on working, tested foundation |
| Configuration | Project metadata JSON | Pattern used by SpecFlow (`specflow_enabled`) |
| Work item tracking | Existing blackboard | Unified dispatch queue |

## Data Model

### Enhanced ReworkMetadata Interface

The existing `ReworkMetadata` interface in `rework.ts` will be extended:

```typescript
export interface ReworkMetadata {
  rework: true;
  pr_number: number;
  pr_url: string;
  repo: string;
  branch: string;
  implementation_work_item_id: string;
  review_feedback: string;           // Summary from review
  rework_cycle: number;
  project_id: string;
  // --- NEW FIELDS for F-020 ---
  worktree_path?: string;            // Preserved from original implement phase
  inline_comments?: InlineComment[]; // Parsed file-level comments
  max_rework_cycles?: number;        // Configurable per-project (default: 2)
}

interface InlineComment {
  path: string;       // e.g., "src/lib/auth.ts"
  line: number;       // Line number
  body: string;       // Comment text
  author: string;     // Reviewer login
  created_at: string; // ISO timestamp
}
```

### Worktree Path Persistence

The worktree path must flow through the metadata chain:

```
implement work item    →    code_review work item    →    rework work item
  metadata: {                 metadata: {                   metadata: {
    ...                         pr_number,                    pr_number,
  }                             branch,                       branch,
  worktree created at:          worktree_path ←──────────────worktree_path,
  ~/.pai/worktrees/...        }                             }
```

The `worktree_path` is set by the implement phase and propagated through `code_review` to `rework` items.

## Implementation Phases

### Phase 1: Comment Parsing Module (~100 lines)

Create `src/scheduler/pr-comments.ts`:

```typescript
/**
 * Fetch all review comments from a PR using gh API.
 * Returns within 30 seconds or throws timeout error.
 */
export async function fetchPRComments(
  repo: string,
  prNumber: number,
): Promise<{ reviews: Review[]; inlineComments: InlineComment[] }>;

/**
 * Format comments into a structured prompt section.
 */
export function formatCommentsForPrompt(
  reviews: Review[],
  comments: InlineComment[],
): string;
```

Implementation pattern:
```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);

const proc = Bun.spawn(['gh', 'api', `repos/${repo}/pulls/${prNumber}/comments`], {
  stdout: 'pipe',
  stderr: 'pipe',
});

// Race against timeout
```

### Phase 2: Enhanced Rework Creation (~50 lines modified)

Modify `createReworkWorkItem()` in `rework.ts`:

1. Add idempotency check:
```typescript
// Check for existing rework item for this PR/cycle
const existing = bb.listWorkItems({ status: 'pending' })
  .find(i => {
    const meta = parseReworkMeta(i.metadata);
    return meta?.pr_number === opts.prNumber && meta?.rework_cycle === opts.reworkCycle;
  });
if (existing) {
  return existing.item_id; // Idempotent — return existing
}
```

2. Fetch and attach inline comments:
```typescript
const { reviews, inlineComments } = await fetchPRComments(opts.repo, opts.prNumber);
const metadata: ReworkMetadata = {
  ...existingFields,
  inline_comments: inlineComments,
  worktree_path: opts.worktreePath, // Preserved from original
};
```

3. Configurable max cycles:
```typescript
// Read from project metadata or use default
const projectMeta = bb.getProject(opts.projectId)?.metadata;
const maxCycles = projectMeta?.max_rework_cycles ?? DEFAULT_MAX_REWORK_CYCLES;
```

### Phase 3: Enhanced Rework Prompt (~30 lines modified)

Modify `buildReworkPrompt()` to include structured inline comments:

```typescript
export function buildReworkPrompt(meta: ReworkMetadata): string {
  const parts = [
    `You are addressing code review feedback for PR #${meta.pr_number}...`,
    '',
    '## Review Summary',
    meta.review_feedback,
    '',
  ];

  if (meta.inline_comments?.length) {
    parts.push('## File-Level Comments', '');
    for (const c of meta.inline_comments) {
      parts.push(`### ${c.path}:${c.line}`);
      parts.push(`> ${c.body}`);
      parts.push(`— @${c.author}`, '');
    }
  }

  parts.push(
    '## Instructions',
    '...',
    'Address each comment above specifically.',
  );

  return parts.join('\n');
}
```

### Phase 4: Worktree Reuse Logic (~40 lines)

Modify `runRework()` to reuse existing worktree:

```typescript
export async function runRework(...): Promise<void> {
  let wtPath: string;

  // REUSE existing worktree if path is provided and valid
  if (meta.worktree_path && existsSync(meta.worktree_path)) {
    wtPath = meta.worktree_path;
    // Ensure we're on the correct branch
    await ensureBranch(wtPath, meta.branch);
    bb.appendEvent({
      actorId: sessionId,
      targetId: item.item_id,
      summary: `Rework: reusing existing worktree at ${wtPath}`,
    });
  } else {
    // Fallback: create new worktree (shouldn't happen in normal flow)
    wtPath = await createWorktree(project.local_path, meta.branch, meta.project_id);
  }

  // ... rest of existing logic
}
```

### Phase 5: Escalation Enhancement (~20 lines)

Enhance the max-cycle-exceeded path in `createReworkWorkItem()`:

```typescript
if (opts.reworkCycle > maxCycles) {
  // Mark the ORIGINAL implementation work item with human_review_required
  const originalItem = bb.getWorkItem(opts.implementationWorkItemId);
  if (originalItem) {
    const meta = JSON.parse(originalItem.metadata ?? '{}');
    bb.updateWorkItemMetadata(opts.implementationWorkItemId, {
      ...meta,
      human_review_required: true,
      escalation_reason: `Max rework cycles (${maxCycles}) exceeded`,
      escalated_at: new Date().toISOString(),
    });
  }

  bb.appendEvent({
    actorId: opts.sessionId,
    targetId: opts.implementationWorkItemId,
    summary: `PR #${opts.prNumber} exceeded max rework cycles (${maxCycles}) — escalating to human review`,
    metadata: { prNumber: opts.prNumber, maxCycles, eventType: 'human_escalation' },
  });

  return null;
}
```

## File Structure

### Files to Create

| File | Purpose | Lines (est.) |
|------|---------|--------------|
| `src/scheduler/pr-comments.ts` | Comment fetching with 30s timeout, formatting for prompts | ~100 |
| `test/pr-comments.test.ts` | Unit tests for comment parsing, timeout handling | ~120 |

### Files to Modify

| File | Change |
|------|--------|
| `src/scheduler/rework.ts` | Add idempotency check, inline_comments field, worktree_path preservation, configurable max cycles, enhanced escalation |
| `src/scheduler/worktree.ts` | Add `ensureBranch()` helper to verify/checkout branch in existing worktree |
| `src/commands/dispatch-worker.ts` | Pass `worktree_path` through code_review metadata chain |
| `test/rework.test.ts` | Add tests for idempotency, comment integration, escalation |

### Files NOT Modified

| File | Reason (per spec NFR-1) |
|------|------------------------|
| `src/scheduler/review-agent.ts` | Already emits `work_rejected` event and creates rework items — no changes needed |

## Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| `rework.ts` | Exists | Foundation for enhancement |
| `worktree.ts` | Exists | Minor addition (`ensureBranch`) |
| `gh` CLI | External | Must be authenticated |
| ivy-blackboard | Exists | Work item management |

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Worktree cleaned before rework | High | Medium | Graceful fallback to create new worktree; log warning event |
| Comment fetch timeout (>30s) | Medium | Low | AbortController with 30s timeout; proceed with summary only on timeout |
| Duplicate rework items created | Medium | Medium | Idempotency check before creation; unique item ID pattern |
| Project metadata lacks max_cycles | Low | High | Default to 2 (per spec); log info event |
| Inline comments exceed prompt limit | Low | Low | Truncate to most recent N comments; prioritize by severity if available |

## Test Strategy

### Unit Tests (`test/pr-comments.test.ts`)

- Mock `Bun.spawn` to simulate `gh api` responses
- Test timeout enforcement (mock slow response, verify abort)
- Test comment parsing with various formats (reviews, inline, threads)
- Test formatting for prompt output

### Unit Tests (`test/rework.test.ts` additions)

- Test idempotency: calling `createReworkWorkItem` twice returns same ID
- Test worktree reuse path: valid path reused, missing path falls back to create
- Test configurable max cycles: project metadata overrides default
- Test escalation: `human_review_required` set on original item
- Test inline comments included in metadata and prompt

### Integration Tests

- End-to-end: review-agent → rework item → rework agent → re-review item
- Verify metadata chain preserves worktree_path across items
- Verify max cycles reached triggers escalation event

## FR Coverage

| FR | Addressed By |
|----|-------------|
| FR-1: Work item source | Uses existing `rework` source (functionally equivalent to spec's `review_fix`) |
| FR-2: Feedback evaluator | review-agent.ts already handles this — no changes needed |
| FR-3: Fix agent prompt | Enhanced `buildReworkPrompt()` with inline comments |
| FR-4: Fix agent execution | `runRework()` enhanced with worktree reuse |
| FR-5: Max fix cycles | Configurable via project metadata, default 2 |
| FR-6: Re-review work item | Existing flow in `runRework()` — unchanged |
| FR-7: Worktree reuse | `runRework()` checks `meta.worktree_path` first |
| FR-8: Comment parsing | New `pr-comments.ts` module with 30s timeout |

## Key Decisions

1. **Enhance rework.ts, don't create parallel review_fix system** — The existing rework flow already implements 80% of the spec. Creating `review_fix` as a separate source would duplicate logic and fragment the codebase. The semantic difference between "rework" and "review_fix" is minimal.

2. **Worktree path flows through metadata, not computed** — Computing the worktree path from branch name is fragile (different naming conventions). Storing the actual path in metadata ensures the rework agent finds the exact worktree.

3. **Default max cycles is 2 (spec), not 3 (current)** — The spec explicitly states default 2. We make this configurable to allow projects to override.

4. **Comment fetching is synchronous with timeout** — Using async/await with AbortController is simpler than background polling. 30 seconds is generous for typical PR comment counts.

5. **Idempotency via item lookup, not unique constraint** — SQLite INSERT doesn't support ON CONFLICT for our schema. Pre-check lookup is simple and sufficient.
