# Implementation Tasks: GitLab CLI Support for Dispatch Pipeline

## Progress Tracking

| Task | Status | Notes |
|------|--------|-------|
| T-1.1 | ☐ | |
| T-1.2 | ☐ | |
| T-2.1 | ☐ | |
| T-2.2 | ☐ | |
| T-2.3 | ☐ | |
| T-2.4 | ☐ | |
| T-2.5 | ☐ | |
| T-2.6 | ☐ | |
| T-2.7 | ☐ | |
| T-2.8 | ☐ | |
| T-2.9 | ☐ | |
| T-2.10 | ☐ | |
| T-2.11 | ☐ | |
| T-3.1 | ☐ | |
| T-3.2 | ☐ | |
| T-4.1 | ☐ | |
| T-4.2 | ☐ | |
| T-4.3 | ☐ | |
| T-4.4 | ☐ | |
| T-4.5 | ☐ | |
| T-4.6 | ☐ | |
| T-5.1 | ☐ | |
| T-5.2 | ☐ | |
| T-5.3 | ☐ | |
| T-6.1 | ☐ | |
| T-6.2 | ☐ | |
| T-6.3 | ☐ | |
| T-7.1 | ☐ | |
| T-7.2 | ☐ | |
| T-8.1 | ☐ | |
| T-8.2 | ☐ | |
| T-9.1 | ☐ | |
| T-9.2 | ☐ | |
| T-9.3 | ☐ | |
| T-9.4 | ☐ | |
| T-9.5 | ☐ | |
| T-9.6 | ☐ | |
| T-10.1 | ☐ | |
| T-10.2 | ☐ | |
| T-10.3 | ☐ | |
| T-10.4 | ☐ | |
| T-10.5 | ☐ | |
| T-11.1 | ☐ | |
| T-12.1 | ☐ | |
| T-12.2 | ☐ | |

---

## Group 1: Foundation (Types & Detection)

### T-1.1: Define VCS provider interface and types [T]
- **File:** `src/vcs/types.ts`
- **Test:** `tests/vcs/types.test.ts`
- **Dependencies:** none
- **Description:**
  - Define `VCSProvider` interface with all methods (createMR, mergeMR, getMRState, getMRDiff, getMRFiles, postReviewComment, submitReview, fetchReviews, fetchInlineComments, commentOnIssue, getIssueStatus, api)
  - Define supporting types: `VCSPlatform`, `CreateMROptions`, `MRResult`, `MRState`, `ReviewEvent`, `Review`, `InlineComment`, `IssueStatus`
  - Export all types for use by provider implementations

### T-1.2: Implement platform detection [T] [P with T-3.1, T-4.1]
- **File:** `src/vcs/detect.ts`
- **Test:** `tests/vcs/detect.test.ts`
- **Dependencies:** none
- **Description:**
  - Implement `detectPlatform(projectPath: string): Promise<VCSPlatform>` using git remote URL parsing
  - Detection rules: gitlab.com or gitlab. → 'gitlab', default → 'github'
  - Test coverage: github.com URL, gitlab.com URL, self-hosted gitlab URL, unknown URL (defaults to github)

---

## Group 2: GitHub Provider (Extract Existing Logic)

### T-2.1: Create GitHubProvider class structure [T]
- **File:** `src/vcs/github-provider.ts`
- **Test:** `tests/vcs/github-provider.test.ts`
- **Dependencies:** T-1.1
- **Description:**
  - Create `GitHubProvider` class implementing `VCSProvider` interface
  - Add `platform: 'github'` property
  - Set up constructor with `projectPath` parameter
  - Stub all interface methods (implementation in subsequent tasks)

### T-2.2: Extract gh() helper from worktree.ts [T]
- **File:** `src/vcs/github-provider.ts`
- **Test:** `tests/vcs/github-provider.test.ts` (extend existing)
- **Dependencies:** T-2.1
- **Description:**
  - Copy `gh()` helper from `src/scheduler/worktree.ts` into GitHubProvider as private method
  - Add error handling and timeout support
  - Test with mocked subprocess calls

### T-2.3: Implement GitHub createMR method [T]
- **File:** `src/vcs/github-provider.ts`
- **Test:** `tests/vcs/github-provider.test.ts` (extend)
- **Dependencies:** T-2.2
- **Description:**
  - Implement `createMR()` using `gh pr create --title --body --base`
  - Parse PR number and URL from CLI output
  - Return `{ number, url }`
  - Test: verify correct command construction, parse output, handle errors

### T-2.4: Implement GitHub mergeMR method [T]
- **File:** `src/vcs/github-provider.ts`
- **Test:** `tests/vcs/github-provider.test.ts` (extend)
- **Dependencies:** T-2.2
- **Description:**
  - Implement `mergeMR()` using `gh pr merge N --squash --delete-branch`
  - Return boolean success/failure
  - Test: verify command, handle merge conflicts, handle permission errors

### T-2.5: Implement GitHub getMRState method [T]
- **File:** `src/vcs/github-provider.ts`
- **Test:** `tests/vcs/github-provider.test.ts` (extend)
- **Dependencies:** T-2.2
- **Description:**
  - Implement `getMRState()` using `gh pr view N --json state --jq .state`
  - Parse state: MERGED, OPEN, CLOSED
  - Return null if PR not found
  - Test: all state values, not found case

### T-2.6: Implement GitHub diff and file list methods [T]
- **File:** `src/vcs/github-provider.ts`
- **Test:** `tests/vcs/github-provider.test.ts` (extend)
- **Dependencies:** T-2.2
- **Description:**
  - Implement `getMRDiff()` using `gh pr diff N`
  - Implement `getMRFiles()` using `gh pr view N --json files --jq '.files[].path'`
  - Test: verify commands, parse output correctly

### T-2.7: Extract ghApi() from pr-comments.ts [T]
- **File:** `src/vcs/github-provider.ts`
- **Test:** `tests/vcs/github-provider.test.ts` (extend)
- **Dependencies:** T-2.2
- **Description:**
  - Copy `ghApi()` logic from `src/scheduler/pr-comments.ts` into GitHubProvider as private method
  - Add generic `api<T>(endpoint, timeoutMs?)` public method wrapping ghApi
  - Test: verify API call construction, JSON parsing, error handling

### T-2.8: Implement GitHub review methods [T]
- **File:** `src/vcs/github-provider.ts`
- **Test:** `tests/vcs/github-provider.test.ts` (extend)
- **Dependencies:** T-2.7
- **Description:**
  - Implement `postReviewComment()` using `gh pr review N --comment --body`
  - Implement `submitReview()` using `gh pr review N --approve|--request-changes --body`
  - Implement `fetchReviews()` using `gh api /repos/.../pulls/N/reviews`
  - Implement `fetchInlineComments()` using `gh api /repos/.../pulls/N/comments`
  - Test: all review operations, parse API responses correctly

### T-2.9: Implement GitHub issue methods [T]
- **File:** `src/vcs/github-provider.ts`
- **Test:** `tests/vcs/github-provider.test.ts` (extend)
- **Dependencies:** T-2.7
- **Description:**
  - Implement `commentOnIssue()` using `gh issue comment N --body`
  - Implement `getIssueStatus()` using `gh api /repos/OWNER/REPO/issues/N`
  - Parse issue response: number, state, title, body, author, labels
  - Test: comment posting, status fetching, parse response

### T-2.10: Add GitHub URL parsing utility [T]
- **File:** `src/vcs/github-provider.ts`
- **Test:** `tests/vcs/github-provider.test.ts` (extend)
- **Dependencies:** T-2.1
- **Description:**
  - Implement private `extractPRNumber(url: string): number | null` method
  - Regex: `/github\.com\/[^\/]+\/[^\/]+\/pull\/(\d+)/`
  - Test: various GitHub URL formats, invalid URLs

### T-2.11: Add GitHub authentication check [T]
- **File:** `src/vcs/github-provider.ts`
- **Test:** `tests/vcs/github-provider.test.ts` (extend)
- **Dependencies:** T-2.2
- **Description:**
  - Implement `validateAuth()` method using `gh auth status`
  - Throw clear error with instructions if not authenticated
  - Call in constructor
  - Test: authenticated state, not authenticated state

---

## Group 3: Provider Factory

### T-3.1: Implement provider factory [T] [P with T-1.2, T-4.1]
- **File:** `src/vcs/index.ts`
- **Test:** `tests/vcs/factory.test.ts`
- **Dependencies:** T-1.1, T-1.2, T-2.1 (GitHub provider structure)
- **Description:**
  - Implement `getProvider(projectPath, projectMetadata?)` factory function
  - Priority: metadata.vcs_platform override → auto-detection → default 'github'
  - Implement `createProvider(platform, projectPath)` helper
  - Re-export types from types.ts
  - Test: explicit override, auto-detection, default fallback

### T-3.2: Add provider initialization error handling [T]
- **File:** `src/vcs/index.ts`
- **Test:** `tests/vcs/factory.test.ts` (extend)
- **Dependencies:** T-3.1
- **Description:**
  - Wrap provider creation in try-catch
  - Catch auth validation errors, CLI not found errors
  - Throw user-friendly errors with installation/auth instructions
  - Test: missing CLI, auth failure, platform detection failure

---

## Group 4: GitLab Provider (New Implementation)

### T-4.1: Create GitLabProvider class structure [T] [P with T-1.2, T-3.1]
- **File:** `src/vcs/gitlab-provider.ts`
- **Test:** `tests/vcs/gitlab-provider.test.ts`
- **Dependencies:** T-1.1
- **Description:**
  - Create `GitLabProvider` class implementing `VCSProvider` interface
  - Add `platform: 'gitlab'` property
  - Add private `glab()` helper method (analogous to gh())
  - Stub all interface methods

### T-4.2: Implement GitLab MR operations [T]
- **File:** `src/vcs/gitlab-provider.ts`
- **Test:** `tests/vcs/gitlab-provider.test.ts` (extend)
- **Dependencies:** T-4.1
- **Description:**
  - Implement `createMR()` using `glab mr create --title --description --target-branch`
  - Implement `mergeMR()` using `glab mr merge N --squash --remove-source-branch --yes`
  - Implement `getMRState()` using `glab mr view N --output json`, parse `.state`
  - Test: verify CLI commands match GitLab syntax, parse JSON output

### T-4.3: Implement GitLab diff and file list [T]
- **File:** `src/vcs/gitlab-provider.ts`
- **Test:** `tests/vcs/gitlab-provider.test.ts` (extend)
- **Dependencies:** T-4.1
- **Description:**
  - Implement `getMRDiff()` using `glab mr diff N`
  - Implement `getMRFiles()` using `glab mr diff N --name-only`
  - Test: verify commands, parse output

### T-4.4: Implement GitLab review methods with mapping [T]
- **File:** `src/vcs/gitlab-provider.ts`
- **Test:** `tests/vcs/gitlab-provider.test.ts` (extend)
- **Dependencies:** T-4.1
- **Description:**
  - Implement `postReviewComment()` using `glab mr note N --message`
  - Implement `submitReview()` with mapping:
    - APPROVE → `glab mr approve N` + optional note
    - REQUEST_CHANGES → `glab mr note N --message "Changes requested: ..."`
  - Implement `fetchReviews()` using `glab api /projects/:id/merge_requests/N/approvals`
  - Implement `fetchInlineComments()` using `glab api /projects/:id/merge_requests/N/notes`
  - Test: review event mapping, note prefix for request changes

### T-4.5: Implement GitLab issue methods [T]
- **File:** `src/vcs/gitlab-provider.ts`
- **Test:** `tests/vcs/gitlab-provider.test.ts` (extend)
- **Dependencies:** T-4.1
- **Description:**
  - Implement `commentOnIssue()` using `glab issue note N --message`
  - Implement `getIssueStatus()` using `glab api /projects/:id/issues/N`
  - Parse issue response to match IssueStatus interface
  - Test: comment posting, status fetching, JSON parsing

### T-4.6: Add GitLab URL parsing and auth check [T]
- **File:** `src/vcs/gitlab-provider.ts`
- **Test:** `tests/vcs/gitlab-provider.test.ts` (extend)
- **Dependencies:** T-4.1
- **Description:**
  - Implement private `extractMRNumber(url: string): number | null` method
  - Regex: `/gitlab\.com\/[^\/]+\/[^\/]+\/-\/merge_requests\/(\d+)/`
  - Implement `validateAuth()` using `glab auth status`
  - Test: GitLab URL parsing, auth validation

---

## Group 5: Refactor worktree.ts (Critical Path)

### T-5.1: Replace gh() calls with provider in worktree.ts [T]
- **File:** `src/scheduler/worktree.ts`
- **Test:** `tests/scheduler/worktree.test.ts` (extend existing)
- **Dependencies:** T-2.11 (GitHub provider complete), T-3.1 (factory)
- **Description:**
  - Remove `gh()` helper (now in GitHubProvider)
  - Add `provider: VCSProvider` parameter to all PR-related functions: `createPR`, `mergePR`, `getPRState`, `getDiffSummary`, `fetchPRFiles`
  - Replace direct `gh` calls with provider methods: `provider.createMR()`, `provider.mergeMR()`, etc.
  - Keep `git()` helper unchanged (platform-independent)
  - **Critical:** Preserve existing function signatures for backwards compatibility
  - Test: regression tests with GitHub provider, verify no behavior change

### T-5.2: Update worktree.ts function callers [T]
- **File:** `src/scheduler/worktree.ts`, `src/scheduler/specflow-runner.ts`, `src/scheduler/pr-merge.ts`, `src/scheduler/merge-fix.ts`, `src/scheduler/rework.ts`
- **Test:** Integration tests for each caller
- **Dependencies:** T-5.1
- **Description:**
  - Update all call sites of worktree functions to pass `provider` parameter
  - Verify no breaking changes to existing GitHub workflows
  - Test: full dispatch cycle with GitHub provider

### T-5.3: Add provider factory calls at dispatch entry points [T]
- **File:** `src/scheduler/scheduler.ts`, `src/commands/dispatch-worker.ts`
- **Test:** Integration tests
- **Dependencies:** T-3.1, T-5.2
- **Description:**
  - Initialize provider at dispatch start: `const provider = await getProvider(project.local_path, project.metadata)`
  - Thread provider through all handler invocations
  - Test: provider initialization, correct provider selected per project

---

## Group 6: Refactor pr-comments.ts

### T-6.1: Replace ghApi() with provider in pr-comments.ts [T]
- **File:** `src/scheduler/pr-comments.ts`
- **Test:** `tests/scheduler/pr-comments.test.ts` (extend)
- **Dependencies:** T-2.7 (GitHub provider api method)
- **Description:**
  - Remove `ghApi()` helper
  - Add `provider: VCSProvider` parameter to comment functions
  - Replace API calls with `provider.api()`, `provider.fetchInlineComments()`, `provider.postReviewComment()`
  - Test: verify no behavior change with GitHub provider

### T-6.2: Update pr-comments.ts callers [T]
- **File:** `src/scheduler/review-agent.ts`, `src/scheduler/rework.ts`
- **Test:** Integration tests
- **Dependencies:** T-6.1
- **Description:**
  - Update all call sites to pass provider
  - Test: review comment posting, inline comment fetching

### T-6.3: Optional rename to vcs-comments.ts
- **File:** `src/scheduler/pr-comments.ts` → `src/scheduler/vcs-comments.ts`
- **Test:** Update imports
- **Dependencies:** T-6.2
- **Description:**
  - Rename file to reflect platform-agnostic purpose
  - Update all imports in dependent files
  - Test: verify no regressions

---

## Group 7: Refactor review-agent.ts

### T-7.1: Make review prompt provider-aware [T]
- **File:** `src/scheduler/review-agent.ts`
- **Test:** `tests/scheduler/review-agent.test.ts` (extend)
- **Dependencies:** T-5.1, T-6.1
- **Description:**
  - Add `provider: VCSProvider` parameter to review agent launcher
  - Replace hardcoded `gh pr diff` in prompt with `provider.getMRDiff()`
  - Replace `gh pr view` with `provider.getMRState()`
  - Update prompt template to use "PR/MR" terminology (platform-agnostic)
  - Test: review prompt generated correctly with both providers

### T-7.2: Update review-agent.ts callers [T]
- **File:** `src/scheduler/scheduler.ts`, `src/commands/dispatch-worker.ts`
- **Test:** Integration tests
- **Dependencies:** T-7.1
- **Description:**
  - Update review phase invocations to pass provider
  - Test: full review cycle with both providers

---

## Group 8: Refactor issue-watcher.ts

### T-8.1: Rename and refactor github-issue-watcher.ts [T]
- **File:** `src/evaluators/github-issue-watcher.ts` → `src/evaluators/issue-watcher.ts`
- **Test:** `tests/evaluators/issue-watcher.test.ts` (extend)
- **Dependencies:** T-2.9 (GitHub issue methods), T-4.5 (GitLab issue methods)
- **Description:**
  - Rename file to `issue-watcher.ts`
  - Add `provider: VCSProvider` parameter
  - Replace `gh api` calls with `provider.getIssueStatus()`, `provider.commentOnIssue()`
  - Test: issue watching with both providers

### T-8.2: Update evaluator registry [T]
- **File:** Evaluator registry file (wherever issue-watcher is registered)
- **Test:** Integration tests
- **Dependencies:** T-8.1
- **Description:**
  - Update registration with new name and provider parameter
  - Test: evaluator triggered correctly

---

## Group 9: Wire into Dispatch Pipeline (Integration)

### T-9.1: Thread provider through scheduler.ts [T]
- **File:** `src/scheduler/scheduler.ts`
- **Test:** Integration tests
- **Dependencies:** T-5.3, T-7.2
- **Description:**
  - Initialize provider at dispatch start
  - Thread through implement, review, rework, merge handlers
  - Test: full dispatch cycle with GitHub provider (regression)

### T-9.2: Thread provider through dispatch-worker.ts [T]
- **File:** `src/commands/dispatch-worker.ts`
- **Test:** Integration tests
- **Dependencies:** T-9.1
- **Description:**
  - Initialize provider in worker
  - Pass to all handler calls
  - Test: background dispatch with GitHub provider

### T-9.3: Update specflow-runner.ts [T]
- **File:** `src/scheduler/specflow-runner.ts`
- **Test:** Integration tests
- **Dependencies:** T-5.2
- **Description:**
  - Pass provider to `createPR()` calls in complete phase
  - Test: PR creation in specflow complete phase

### T-9.4: Update rework.ts [T]
- **File:** `src/scheduler/rework.ts`
- **Test:** Integration tests
- **Dependencies:** T-6.2, T-7.2
- **Description:**
  - Accept provider parameter
  - Pass to worktree and review functions
  - Test: rework cycle with GitHub provider

### T-9.5: Update merge-fix.ts [T]
- **File:** `src/scheduler/merge-fix.ts`
- **Test:** Integration tests
- **Dependencies:** T-5.2
- **Description:**
  - Accept provider parameter (minimal changes, uses worktree functions)
  - Test: merge-fix cycle with GitHub provider

### T-9.6: Update pr-merge.ts [T]
- **File:** `src/scheduler/pr-merge.ts`
- **Test:** Integration tests
- **Dependencies:** T-5.2
- **Description:**
  - Accept provider parameter (minimal changes, uses worktree functions)
  - Test: PR merge with GitHub provider

---

## Group 10: Comprehensive Testing

### T-10.1: GitHub provider regression test suite [T]
- **File:** `tests/vcs/github-provider.test.ts` (comprehensive suite)
- **Test:** Self
- **Dependencies:** T-2.11 (all GitHub provider methods complete)
- **Description:**
  - Comprehensive unit tests for all GitHub provider methods
  - Mock `gh` CLI calls
  - Test error handling, edge cases, URL parsing
  - Verify backwards compatibility with existing behavior

### T-10.2: GitLab provider test suite [T]
- **File:** `tests/vcs/gitlab-provider.test.ts` (comprehensive suite)
- **Test:** Self
- **Dependencies:** T-4.6 (all GitLab provider methods complete)
- **Description:**
  - Comprehensive unit tests for all GitLab provider methods
  - Mock `glab` CLI calls
  - Test review event mapping (APPROVE, REQUEST_CHANGES)
  - Test URL parsing (GitLab format)

### T-10.3: Provider factory and detection tests [T]
- **File:** `tests/vcs/factory.test.ts`, `tests/vcs/detect.test.ts`
- **Test:** Self
- **Dependencies:** T-3.2, T-1.2
- **Description:**
  - Test auto-detection from various remote URLs (github.com, gitlab.com, self-hosted)
  - Test explicit override via metadata
  - Test default fallback
  - Test mixed project setup (multiple projects with different platforms)
  - Test error handling (missing CLI, auth failure)

### T-10.4: Integration test: GitHub dispatch cycle [T]
- **File:** `tests/integration/dispatch-github.test.ts`
- **Test:** Self
- **Dependencies:** T-9.6 (all pipeline wiring complete)
- **Description:**
  - Full dispatch cycle regression test with GitHub provider
  - Verify no behavior changes from refactoring
  - Test: register project → implement → review → merge

### T-10.5: Integration test: GitLab dispatch cycle [T]
- **File:** `tests/integration/dispatch-gitlab.test.ts`
- **Test:** Self
- **Dependencies:** T-9.6
- **Description:**
  - Full dispatch cycle with mocked `glab` CLI
  - Test: register GitLab project → implement → review → merge
  - Verify GitLab-specific CLI commands called correctly

---

## Group 11: Documentation

### T-11.1: Write documentation [P with all implementation tasks]
- **Files:**
  - `docs/vcs-providers.md`
  - `docs/gitlab-setup.md`
  - Update existing dispatch pipeline docs
- **Test:** Manual review
- **Dependencies:** none (can be written in parallel)
- **Description:**
  - Architecture overview of VCS provider abstraction
  - How to add new providers (extension guide)
  - GitLab setup: `glab` installation, authentication
  - Update dispatch pipeline docs with GitLab examples
  - Project metadata `vcs_platform` override documentation

---

## Group 12: Manual Validation (Final)

### T-12.1: Manual GitHub validation
- **Test:** Manual
- **Dependencies:** T-10.4 (GitHub integration tests pass)
- **Description:**
  - Manually test with real GitHub project
  - Verify full dispatch cycle works identically to pre-refactor behavior
  - Verify no regressions in PR creation, review, merge

### T-12.2: Manual GitLab validation
- **Test:** Manual
- **Dependencies:** T-10.5 (GitLab integration tests pass)
- **Description:**
  - Manually test with real GitLab project
  - Clone GitLab repository, register in blackboard
  - Run full dispatch cycle (implement → review → merge)
  - Verify MR creation, review comments, merge on GitLab UI

---

## Execution Order

**Phase 1: Foundation (parallel)**
1. T-1.1 (VCS types) — no deps
2. T-1.2 (detection) — no deps [P]
3. T-4.1 (GitLab structure) — T-1.1 only [P]

**Phase 2: GitHub Provider (sequential)**
4. T-2.1 (GitHub structure) — T-1.1
5. T-2.2 (gh helper) — T-2.1
6. T-2.3 through T-2.11 (GitHub methods) — T-2.2 or T-2.7

**Phase 3: Factory (after detection + one provider)**
7. T-3.1 (factory) — T-1.2, T-2.1
8. T-3.2 (error handling) — T-3.1

**Phase 4: GitLab Provider (sequential, parallel with GitHub if desired)**
9. T-4.2 through T-4.6 (GitLab methods) — T-4.1

**Phase 5: Refactor worktree (critical path — after GitHub provider complete)**
10. T-5.1 (refactor worktree) — T-2.11, T-3.1
11. T-5.2 (update callers) — T-5.1
12. T-5.3 (dispatch entry points) — T-3.1, T-5.2

**Phase 6: Refactor supporting modules (parallel with Phase 5 if careful)**
13. T-6.1 (refactor pr-comments) — T-2.7
14. T-6.2 (update callers) — T-6.1
15. T-6.3 (rename) — T-6.2 [optional]
16. T-7.1 (refactor review-agent) — T-5.1, T-6.1
17. T-7.2 (update callers) — T-7.1
18. T-8.1 (refactor issue-watcher) — T-2.9, T-4.5
19. T-8.2 (update registry) — T-8.1

**Phase 7: Pipeline wiring (after all refactors)**
20. T-9.1 through T-9.6 (wire providers through pipeline) — T-5.3, T-7.2, T-8.2

**Phase 8: Testing (parallel after implementation)**
21. T-10.1 (GitHub tests) — T-2.11
22. T-10.2 (GitLab tests) — T-4.6
23. T-10.3 (factory tests) — T-3.2
24. T-10.4 (GitHub integration) — T-9.6
25. T-10.5 (GitLab integration) — T-9.6

**Phase 9: Documentation (anytime)**
26. T-11.1 (docs) — can start anytime

**Phase 10: Manual validation (last)**
27. T-12.1 (GitHub manual) — T-10.4
28. T-12.2 (GitLab manual) — T-10.5

**Parallelization opportunities:**
- T-1.2 (detection) parallel with T-4.1 (GitLab structure) and T-3.1 (factory)
- T-2.x (GitHub provider) can be partially parallel with T-4.x (GitLab provider) after T-2.1 and T-4.1 complete
- T-10.x (tests) parallel with each other once dependencies met
- T-11.1 (docs) can run parallel with all implementation

**Critical path (longest dependency chain):**
T-1.1 → T-2.1 → T-2.2 → T-2.11 → T-5.1 → T-5.2 → T-5.3 → T-9.x → T-10.4 → T-12.1

**Estimated duration:** ~9-10 hours (per technical plan)
