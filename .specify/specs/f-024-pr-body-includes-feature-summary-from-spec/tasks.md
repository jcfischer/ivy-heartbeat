# Implementation Tasks: PR Body Includes Feature Summary from Spec

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | ☐ | |
| T-2.1 | ☐ | |
| T-2.2 | ☐ | |
| T-2.3 | ☐ | |
| T-3.1 | ☐ | |
| T-4.1 | ☐ | |
| T-4.2 | ☐ | |
| T-5.1 | ☐ | |
| T-5.2 | ☐ | |
| T-5.3 | ☐ | |

## Group 1: Foundation

### T-1.1: Create PR body extractor module structure [T]
- **File:** `src/lib/pr-body-extractor.ts`
- **Test:** `tests/pr-body-extractor.test.ts`
- **Dependencies:** none
- **Description:** Create module with TypeScript interfaces (`PRBodyData`, `FileChange`) and function stubs for extraction utilities. Export all functions for use in specflow-runner.ts.

## Group 2: Extraction Logic

### T-2.1: Implement extractProblemStatement function [T] [P with T-2.2, T-2.3]
- **File:** `src/lib/pr-body-extractor.ts`
- **Test:** `tests/pr-body-extractor.test.ts`
- **Dependencies:** T-1.1
- **Description:** Parse spec markdown to locate Problem Statement section (flexible regex matching `## Problem Statement`, `# Problem`, `## Problem`). Extract first 2-3 sentences or up to 300 characters. Return fallback text "See spec.md for full feature details" if section not found.

### T-2.2: Implement extractKeyDecisions function [T] [P with T-2.1, T-2.3]
- **File:** `src/lib/pr-body-extractor.ts`
- **Test:** `tests/pr-body-extractor.test.ts`
- **Dependencies:** T-1.1
- **Description:** Parse plan markdown to find decision sections (e.g., "Technical Approach", "Key Decisions", "Implementation Strategy"). Extract up to 5 bullet points (lines starting with `-` or `*`). Return fallback array `["See plan.md for implementation details"]` if no sections found.

### T-2.3: Implement getFilesChangedSummary function [T] [P with T-2.1, T-2.2]
- **File:** `src/lib/pr-body-extractor.ts`
- **Test:** `tests/pr-body-extractor.test.ts`
- **Dependencies:** T-1.1
- **Description:** Execute `git diff --stat ${baseBranch}...${featureBranch}` and parse output into structured `FileChange[]` array with path, additions, deletions. Handle git command failures gracefully by returning empty array.

## Group 3: Formatting

### T-3.1: Implement formatFilesChanged utility [T]
- **File:** `src/lib/pr-body-extractor.ts`
- **Test:** `tests/pr-body-extractor.test.ts`
- **Dependencies:** T-2.3
- **Description:** Format `FileChange[]` array as markdown table with columns: File, Changes. Return fallback message "_See PR diff for file changes_" if array is empty.

## Group 4: Integration

### T-4.1: Wire extraction utilities into specflow-runner.ts [T]
- **File:** `src/scheduler/specflow-runner.ts` (modify around line 1358)
- **Test:** `tests/specflow-runner.test.ts`
- **Dependencies:** T-2.1, T-2.2, T-2.3, T-3.1
- **Description:** Import extraction functions. Read spec.md and plan.md from feature branch using `Bun.file()`. Call extraction functions to build `PRBodyData`. Replace existing stub PR body with new template format including Summary, Implementation Approach, Files Changed, and Full Documentation sections.

### T-4.2: Add character limit truncation [T]
- **File:** `src/scheduler/specflow-runner.ts`
- **Test:** `tests/specflow-runner.test.ts`
- **Dependencies:** T-4.1
- **Description:** Add logic to truncate PR body to 4000 characters if exceeded. Append "..." indicator when truncated. Place before GitHub API call.

## Group 5: Testing

### T-5.1: Create unit tests for extraction functions [T]
- **File:** `tests/pr-body-extractor.test.ts`
- **Test:** N/A (this IS the test file)
- **Dependencies:** T-2.1, T-2.2, T-2.3, T-3.1
- **Description:** Test cases: (1) Happy path with valid Problem Statement, (2) Missing Problem Statement → fallback, (3) Missing plan sections → fallback, (4) Malformed markdown → graceful handling, (5) Files changed formatting with empty/full arrays, (6) Git command failure handling.

### T-5.2: Update specflow-runner integration tests [T]
- **File:** `tests/specflow-runner.test.ts`
- **Test:** N/A (this IS the test file)
- **Dependencies:** T-4.1, T-4.2
- **Description:** Verify existing PR body tests still pass. Add new assertions for enhanced PR body format: Summary section exists, Implementation Approach section exists, Files Changed section exists, Full Documentation links present, spec/plan links functional.

### T-5.3: Add edge case tests [T]
- **File:** `tests/pr-body-extractor.test.ts`
- **Test:** N/A (this IS the test file)
- **Dependencies:** T-5.1
- **Description:** Test edge cases: (1) Very long content → truncation at 4000 chars with "...", (2) Spec/plan files missing entirely → graceful fallback, (3) Multiple heading variations (case sensitivity, spacing), (4) Empty spec/plan files → no crash.

## Execution Order

### Batch 1 (sequential foundation)
1. T-1.1 (no dependencies)

### Batch 2 (parallel extraction logic)
2. T-2.1, T-2.2, T-2.3 (can run in parallel after T-1.1)

### Batch 3 (sequential formatting)
3. T-3.1 (depends on T-2.3)

### Batch 4 (sequential integration)
4. T-4.1 (depends on all extraction + formatting)
5. T-4.2 (depends on T-4.1)

### Batch 5 (parallel testing)
6. T-5.1 (depends on T-2.x and T-3.1)
7. T-5.2 (depends on T-4.x)
8. T-5.3 (depends on T-5.1)

## Summary

- **Total tasks:** 11
- **Parallelizable:** 3 (T-2.1, T-2.2, T-2.3)
- **Critical path:** T-1.1 → T-2.x → T-3.1 → T-4.1 → T-4.2 → T-5.2
- **Testing coverage:** 8 test-required tasks (all implementation + test tasks)
