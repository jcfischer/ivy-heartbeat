---
prd: true
id: PRD-20260225-f023-gitlab-cli-isc
status: CRITERIA_DEFINED
mode: interactive
effort_level: Extended
created: 2026-02-25
updated: 2026-02-25
iteration: 0
maxIterations: 128
loopStatus: null
last_phase: OBSERVE
failing_criteria: []
verification_summary: "0/70"
parent: null
children: []
---

# F-023 GitLab CLI Support -- Ideal State Criteria

> Comprehensive ISC for the VCS provider abstraction enabling GitHub and GitLab CLI support in the ivy-heartbeat dispatch pipeline, covering 45 implementation tasks across 12 groups.

## STATUS

| What | State |
|------|-------|
| Progress | 0/70 criteria defined |
| Phase | OBSERVE (ISC Construction) |
| Next action | THINK -- pressure test criteria |
| Blocked by | Nothing |

## CONTEXT

### Problem Space
The dispatch pipeline (PR creation, merge, review, issue watching, rework, merge-fix) is hardcoded to GitHub's `gh` CLI. Projects on GitLab cannot use the automated implement-review-merge cycle. A VCS provider abstraction decouples the pipeline from platform-specific CLIs so the same workflow works with both `gh` and `glab`.

### Key Files
- `src/scheduler/worktree.ts` -- Contains `gh()` helper and all PR-related functions to be refactored
- `src/scheduler/pr-comments.ts` -- Contains `ghApi()` helper and PR comment fetching
- `src/scheduler/review-agent.ts` -- Hardcoded `gh pr diff`/`gh pr view` in review prompts
- `src/evaluators/github-issue-watcher.ts` -- GitHub-specific issue status fetching
- `src/evaluators/github-pr-review.ts` -- PR review evaluator with GitHub-only fetcher
- `src/evaluators/github-issues.ts` -- GitHub issue evaluator with `extractOwnerRepo()`
- `src/scheduler/scheduler.ts` -- Dispatch entry point
- `src/commands/dispatch-worker.ts` -- Background dispatch worker
- `src/scheduler/specflow-runner.ts` -- SpecFlow completion creates PRs
- `src/scheduler/rework.ts` -- Rework cycle handler
- `src/scheduler/merge-fix.ts` -- Merge conflict resolution
- `src/scheduler/pr-merge.ts` -- PR merge handler
- `.specify/specs/f-023-gitlab-cli-support-for-dispatch-pipeline/spec.md` -- Feature specification
- `.specify/specs/f-023-gitlab-cli-support-for-dispatch-pipeline/plan.md` -- Technical plan
- `.specify/specs/f-023-gitlab-cli-support-for-dispatch-pipeline/tasks.md` -- 45 implementation tasks

### Constraints
- Zero new npm dependencies (pure CLI abstraction)
- Backward compatibility with all existing GitHub workflows
- TDD workflow required (tests alongside implementation)
- PR terminology preserved in type names and metadata
- git() helper stays unchanged (platform-independent)
- 30-second default timeout on API calls preserved
- Extract existing logic, don't rewrite from scratch

### Decisions Made
- Strategy pattern for VCS provider abstraction
- Factory with 3-tier detection: metadata override > git remote URL > default GitHub
- GitLab REQUEST_CHANGES maps to note with parseable prefix
- File rename: github-issue-watcher.ts to issue-watcher.ts
- New directory: src/vcs/ for all provider code

## PLAN

See `.specify/specs/f-023-gitlab-cli-support-for-dispatch-pipeline/plan.md` for full technical plan with architecture diagrams, CLI command mappings, and phased rollout strategy.

## IDEAL STATE CRITERIA (Verification Criteria)

### IFACE: Interface & Types (VCS Abstraction Layer)

- [ ] ISC-IFACE-1: VCSProvider interface exported from src/vcs/types.ts file [E] [CRITICAL] | Verify: Read: check file exists with interface definition
- [ ] ISC-IFACE-2: VCSProvider interface defines all thirteen required provider methods [E] [CRITICAL] | Verify: Grep: count method signatures in VCSProvider interface
- [ ] ISC-IFACE-3: CreateMROptions type includes cwd title body base head fields [E] [IMPORTANT] | Verify: Read: check type definition has all 5 fields
- [ ] ISC-IFACE-4: MRResult type defines number and url properties correctly [E] [IMPORTANT] | Verify: Read: check MRResult interface
- [ ] ISC-IFACE-5: MRState union type covers MERGED OPEN CLOSED values only [E] [IMPORTANT] | Verify: Grep: check MRState type definition
- [ ] ISC-IFACE-6: ReviewEvent union type covers APPROVE and REQUEST_CHANGES values [E] [IMPORTANT] | Verify: Grep: check ReviewEvent type definition
- [ ] ISC-IFACE-7: Review interface includes id state body author submittedAt fields [E] [IMPORTANT] | Verify: Read: check Review interface has all 5 fields
- [ ] ISC-IFACE-8: InlineComment interface includes path line body author fields [E] [IMPORTANT] | Verify: Read: check InlineComment interface
- [ ] ISC-IFACE-9: IssueStatus interface includes number state title body author labels [E] [IMPORTANT] | Verify: Read: check IssueStatus interface has 6 fields
- [ ] ISC-IFACE-10: VCSPlatform union type covers github and gitlab values [E] [CRITICAL] | Verify: Grep: check VCSPlatform type = 'github' | 'gitlab'

### GHPROV: GitHub Provider (Extract Existing Logic)

- [ ] ISC-GHPROV-1: GitHubProvider class fully implements all VCSProvider interface methods [E] [CRITICAL] | Verify: Static: tsc --noEmit on github-provider.ts
- [ ] ISC-GHPROV-2: GitHubProvider platform property returns literal string value github [E] [IMPORTANT] | Verify: Grep: "platform.*=.*'github'" in github-provider.ts
- [ ] ISC-GHPROV-3: GitHubProvider createMR invokes gh pr create with correct flags [E] [CRITICAL] | Verify: Test: bun test github-provider.test.ts
- [ ] ISC-GHPROV-4: GitHubProvider mergeMR invokes gh pr merge with squash flag [E] [IMPORTANT] | Verify: Test: bun test github-provider.test.ts
- [ ] ISC-GHPROV-5: GitHubProvider getMRState parses MERGED OPEN CLOSED from gh output [E] [IMPORTANT] | Verify: Test: bun test github-provider.test.ts
- [ ] ISC-GHPROV-6: GitHubProvider api method wraps gh api with pagination and timeout [E] [IMPORTANT] | Verify: Test: bun test github-provider.test.ts
- [ ] ISC-GHPROV-7: GitHubProvider submitReview maps APPROVE to gh pr review approve [E] [IMPORTANT] | Verify: Test: bun test github-provider.test.ts
- [ ] ISC-GHPROV-8: GitHubProvider submitReview maps REQUEST_CHANGES to gh request-changes flag [E] [IMPORTANT] | Verify: Test: bun test github-provider.test.ts
- [ ] ISC-GHPROV-9: GitHubProvider extracts PR number from github.com slash pull URL [E] [IMPORTANT] | Verify: Test: bun test github-provider.test.ts
- [ ] ISC-GHPROV-10: GitHubProvider validateAuth calls gh auth status during provider init [E] [IMPORTANT] | Verify: Test: bun test github-provider.test.ts
- [ ] ISC-GHPROV-11: GitHubProvider getIssueStatus fetches issue via gh api repos endpoint [I] [IMPORTANT] | Verify: Test: bun test github-provider.test.ts
- [ ] ISC-GHPROV-12: GitHubProvider fetchInlineComments uses pulls comments API endpoint path [I] [IMPORTANT] | Verify: Test: bun test github-provider.test.ts

### GLPROV: GitLab Provider (New Implementation)

- [ ] ISC-GLPROV-1: GitLabProvider class fully implements all VCSProvider interface methods [E] [CRITICAL] | Verify: Static: tsc --noEmit on gitlab-provider.ts
- [ ] ISC-GLPROV-2: GitLabProvider platform property returns literal string value gitlab [E] [IMPORTANT] | Verify: Grep: "platform.*=.*'gitlab'" in gitlab-provider.ts
- [ ] ISC-GLPROV-3: GitLabProvider createMR invokes glab mr create with description flag [E] [CRITICAL] | Verify: Test: bun test gitlab-provider.test.ts
- [ ] ISC-GLPROV-4: GitLabProvider mergeMR invokes glab mr merge with squash flag [E] [IMPORTANT] | Verify: Test: bun test gitlab-provider.test.ts
- [ ] ISC-GLPROV-5: GitLabProvider getMRState parses state from glab mr view JSON output [E] [IMPORTANT] | Verify: Test: bun test gitlab-provider.test.ts
- [ ] ISC-GLPROV-6: GitLabProvider submitReview APPROVE event maps to glab mr approve [E] [CRITICAL] | Verify: Test: bun test gitlab-provider.test.ts
- [ ] ISC-GLPROV-7: GitLabProvider submitReview REQUEST_CHANGES event maps to glab mr note [E] [CRITICAL] | Verify: Test: bun test gitlab-provider.test.ts
- [ ] ISC-GLPROV-8: GitLabProvider REQUEST_CHANGES note includes Changes requested parseable prefix [E] [IMPORTANT] | Verify: Grep: "Changes requested:" in gitlab-provider.ts
- [ ] ISC-GLPROV-9: GitLabProvider extracts MR number from gitlab.com merge_requests URL format [E] [IMPORTANT] | Verify: Test: bun test gitlab-provider.test.ts
- [ ] ISC-GLPROV-10: GitLabProvider validateAuth calls glab auth status during provider init [E] [IMPORTANT] | Verify: Test: bun test gitlab-provider.test.ts
- [ ] ISC-GLPROV-11: GitLabProvider api method wraps glab api with timeout and pagination [I] [IMPORTANT] | Verify: Test: bun test gitlab-provider.test.ts
- [ ] ISC-GLPROV-12: GitLabProvider commentOnIssue invokes glab issue note with message flag [E] [IMPORTANT] | Verify: Test: bun test gitlab-provider.test.ts

### FACTORY: Factory & Platform Detection

- [ ] ISC-FACTORY-1: getProvider factory function exported from src/vcs/index.ts module file [E] [CRITICAL] | Verify: Read: check function exists in index.ts
- [ ] ISC-FACTORY-2: getProvider prioritizes project metadata vcs_platform over auto-detection logic [E] [CRITICAL] | Verify: Test: bun test factory.test.ts
- [ ] ISC-FACTORY-3: detectPlatform returns gitlab string for gitlab.com hosted remote URLs [E] [IMPORTANT] | Verify: Test: bun test detect.test.ts
- [ ] ISC-FACTORY-4: detectPlatform returns gitlab for self-hosted custom gitlab domain URLs [E] [IMPORTANT] | Verify: Test: bun test detect.test.ts
- [ ] ISC-FACTORY-5: detectPlatform returns github as default for unrecognized remote URLs [E] [IMPORTANT] | Verify: Test: bun test detect.test.ts
- [ ] ISC-FACTORY-6: getProvider returns GitHubProvider instance for github.com hosted remote projects [I] [IMPORTANT] | Verify: Test: bun test factory.test.ts
- [ ] ISC-FACTORY-7: getProvider returns GitLabProvider instance for gitlab.com hosted remote projects [I] [IMPORTANT] | Verify: Test: bun test factory.test.ts

### REFACTOR: Pipeline Integration & Refactoring

- [ ] ISC-REFACTOR-1: worktree.ts standalone gh helper function removed replaced by provider [E] [CRITICAL] | Verify: Grep: confirm no standalone gh() function in worktree.ts
- [ ] ISC-REFACTOR-2: worktree.ts createPR function signature accepts VCSProvider parameter argument [E] [CRITICAL] | Verify: Grep: "provider.*VCSProvider" in worktree.ts createPR signature
- [ ] ISC-REFACTOR-3: worktree.ts git helper function preserved unchanged as platform-independent utility [E] [CRITICAL] | Verify: Grep: confirm git() helper still exists in worktree.ts
- [ ] ISC-REFACTOR-4: pr-comments.ts standalone ghApi helper removed replaced by provider api [E] [IMPORTANT] | Verify: Grep: confirm no standalone ghApi() function
- [ ] ISC-REFACTOR-5: review-agent.ts buildReviewPrompt function accepts VCSProvider parameter argument [E] [IMPORTANT] | Verify: Grep: "provider" in buildReviewPrompt function signature
- [ ] ISC-REFACTOR-6: review-agent.ts review prompt template uses provider-aware platform commands [E] [IMPORTANT] | Verify: Read: check prompt template has no hardcoded gh commands
- [ ] ISC-REFACTOR-7: issue-watcher evaluator uses VCSProvider for platform-agnostic issue fetching [E] [IMPORTANT] | Verify: Grep: "provider" in issue-watcher evaluator
- [ ] ISC-REFACTOR-8: scheduler.ts initializes VCS provider via getProvider at dispatch start [E] [IMPORTANT] | Verify: Grep: "getProvider" call in scheduler.ts
- [ ] ISC-REFACTOR-9: dispatch-worker.ts initializes provider and threads it through all handlers [E] [IMPORTANT] | Verify: Grep: "getProvider" call in dispatch-worker.ts
- [ ] ISC-REFACTOR-10: specflow-runner.ts passes VCS provider to createPR in complete phase [E] [IMPORTANT] | Verify: Grep: "provider" in specflow-runner.ts createPR call

### TEST: Test Coverage

- [ ] ISC-TEST-1: GitHub provider unit tests exist covering all thirteen interface methods [E] [CRITICAL] | Verify: Test: bun test github-provider.test.ts --all pass
- [ ] ISC-TEST-2: GitLab provider unit tests exist covering all thirteen interface methods [E] [CRITICAL] | Verify: Test: bun test gitlab-provider.test.ts --all pass
- [ ] ISC-TEST-3: Platform detection unit tests cover github gitlab and self-hosted URLs [E] [IMPORTANT] | Verify: Test: bun test detect.test.ts --all pass
- [ ] ISC-TEST-4: Factory unit tests cover metadata override and auto-detection code paths [E] [IMPORTANT] | Verify: Test: bun test factory.test.ts --all pass
- [ ] ISC-TEST-5: GitHub dispatch integration test covers full implement review merge cycle [E] [IMPORTANT] | Verify: Test: bun test dispatch-github.test.ts --all pass
- [ ] ISC-TEST-6: GitLab dispatch integration test covers full implement review merge cycle [E] [IMPORTANT] | Verify: Test: bun test dispatch-gitlab.test.ts --all pass
- [ ] ISC-TEST-7: All existing test suites pass without any modification or regression [E] [CRITICAL] | Verify: Test: bun test --all pass
- [ ] ISC-TEST-8: All provider tests use mocked CLI subprocesses not real API calls [I] [IMPORTANT] | Verify: Read: check test files for mock/spy patterns

### COMPAT: Backward Compatibility

- [ ] ISC-COMPAT-1: Existing PR type names preserved unchanged in all metadata field schemas [E] [CRITICAL] | Verify: Grep: no renamed PR type names in metadata schemas
- [ ] ISC-COMPAT-2: Existing exported function signatures in worktree.ts remain externally callable [I] [IMPORTANT] | Verify: Read: check exports match previous API
- [ ] ISC-COMPAT-3: GitHub provider behavior identical to pre-refactor direct gh CLI calls [E] [CRITICAL] | Verify: Test: regression tests pass with GitHub provider

### ERR: Error Handling

- [ ] ISC-ERR-1: Missing glab CLI produces clear error message with installation instructions [E] [IMPORTANT] | Verify: Test: bun test gitlab-provider.test.ts (missing CLI test)
- [ ] ISC-ERR-2: Authentication failure produces clear error with auth login step instructions [E] [IMPORTANT] | Verify: Test: bun test (auth failure test)
- [ ] ISC-ERR-3: Unknown platform detection gracefully defaults to GitHub provider as fallback [E] [IMPORTANT] | Verify: Test: bun test detect.test.ts (unknown URL test)

### ANTI: Anti-Criteria (What Must NOT Happen)

- [ ] ISC-A-ANTI-1: No new npm dependencies added to package.json zero delta [E] [CRITICAL] | Verify: CLI: diff package.json shows zero new dependency lines
- [ ] ISC-A-ANTI-2: No existing GitHub workflow tests broken by VCS refactoring [E] [CRITICAL] | Verify: Test: full existing test suite passes green
- [ ] ISC-A-ANTI-3: No hardcoded gh CLI calls remain in pipeline modules outside vcs [E] [IMPORTANT] | Verify: Grep: no "gh " subprocess calls outside src/vcs/
- [ ] ISC-A-ANTI-4: No git helper function modified or removed from worktree.ts file [E] [CRITICAL] | Verify: Grep: git() helper function present and unchanged
- [ ] ISC-A-ANTI-5: No test files skipped or disabled during F-023 implementation work [E] [CRITICAL] | Verify: Grep: no ".skip" or "xit" in test files added by F-023

## CONSTRAINT-TO-ISC COVERAGE MAP

| Constraint | ISC Criterion |
|------------|---------------|
| EX-1 (45 tasks, 12 groups) | Covered by aggregate of all domain ISCs |
| EX-2 (zero npm deps) | ISC-A-ANTI-1 |
| EX-3 (5 new src files) | ISC-IFACE-1, ISC-GHPROV-1, ISC-GLPROV-1, ISC-FACTORY-1 |
| EX-4 (10 modified files) | ISC-REFACTOR-1 through ISC-REFACTOR-10 |
| EX-5 (10 test files) | ISC-TEST-1 through ISC-TEST-8 |
| EX-6 (2 providers) | ISC-GHPROV-1, ISC-GLPROV-1 |
| EX-7 (13 interface methods) | ISC-IFACE-2 |
| EX-8 (3-tier detection) | ISC-FACTORY-2, ISC-FACTORY-3, ISC-FACTORY-5 |
| EX-9 (30s timeout) | ISC-GHPROV-6, ISC-GLPROV-11 |
| EX-10 (no break GitHub) | ISC-A-ANTI-2, ISC-COMPAT-3 |
| EX-11 (no new packages) | ISC-A-ANTI-1 |
| EX-12 (TDD required) | ISC-TEST-1 through ISC-TEST-8 |
| EX-13 (PR names preserved) | ISC-COMPAT-1 |
| EX-14 (never merge in review) | Covered by existing review-agent constraints |
| EX-15 (git() untouched) | ISC-REFACTOR-3, ISC-A-ANTI-4 |
| EX-16 (13 interface methods) | ISC-IFACE-2 |
| EX-17 (gh and glab CLIs) | ISC-GHPROV-1, ISC-GLPROV-1 |
| EX-18 (auto-detection) | ISC-FACTORY-3, ISC-FACTORY-4, ISC-FACTORY-5 |
| EX-19 (metadata override) | ISC-FACTORY-2 |
| EX-20 (REQUEST_CHANGES as note) | ISC-GLPROV-7, ISC-GLPROV-8 |
| EX-21 (auth validation) | ISC-GHPROV-10, ISC-GLPROV-10 |
| EX-22 (self-hosted GitLab) | ISC-FACTORY-4 |
| EX-23 (extract don't rewrite) | ISC-REFACTOR-1, ISC-GHPROV-3 |
| EX-24 (URL parsing both) | ISC-GHPROV-9, ISC-GLPROV-9 |
| EX-25 (injectable/testable) | ISC-TEST-8 |
| EX-26 (async methods) | ISC-IFACE-2 (implicit in interface) |
| EX-27 (install instructions) | ISC-ERR-1 |
| EX-28 (mocked CLIs in tests) | ISC-TEST-8 |

**Unmapped constraints: 0. All 28 constraints have ISC coverage.**

## DECISIONS

(none yet -- to be populated during BUILD/EXECUTE)

## LOG

### Iteration 0 -- 2026-02-25
- Phase reached: OBSERVE
- Criteria progress: 0/70 defined
- Work done: ISC construction from spec, plan, tasks, and codebase analysis
- Failing: all (not yet verified)
- Context for next iteration: Proceed to THINK for pressure testing, then BUILD
