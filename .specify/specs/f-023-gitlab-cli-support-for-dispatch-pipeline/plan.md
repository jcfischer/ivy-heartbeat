# Technical Plan: GitLab CLI Support for Dispatch Pipeline

## Architecture Overview

The VCS provider abstraction introduces a strategy pattern to decouple the dispatch pipeline from platform-specific CLI implementations. This allows seamless support for both GitHub and GitLab without duplicating pipeline logic.

```
┌─────────────────────────────────────────────────────────┐
│                   Dispatch Pipeline                     │
│  (scheduler.ts, dispatch-worker.ts, specflow-runner)   │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ getProvider(projectPath, metadata)
                     ▼
          ┌──────────────────────┐
          │   VCSProvider        │ ◄─── Interface
          │  (types.ts)          │
          └──────────────────────┘
                     △
                     │
          ┌──────────┴──────────┐
          │                     │
┌─────────▼──────────┐  ┌──────▼──────────────┐
│  GitHubProvider    │  │  GitLabProvider     │
│  (github-provider) │  │  (gitlab-provider)  │
└─────────┬──────────┘  └──────┬──────────────┘
          │                    │
          ▼                    ▼
    ┌─────────┐          ┌─────────┐
    │ gh CLI  │          │glab CLI │
    └─────────┘          └─────────┘

                Platform Detection
         ┌──────────────────────────────┐
         │  1. Project metadata         │
         │     vcs_platform override    │
         │  2. Git remote URL parsing   │
         │     (github.com, gitlab.com) │
         │  3. Default: github          │
         └──────────────────────────────┘
```

**Key architectural decisions:**

1. **Interface-based abstraction** — All platform-specific operations behind `VCSProvider` interface
2. **Backward compatibility** — Existing GitHub-only codepaths refactored to use provider, but type names and metadata fields unchanged ("PR" terminology preserved)
3. **Factory pattern** — `getProvider()` encapsulates detection logic and provider instantiation
4. **Minimal surface area** — Existing `worktree.ts` functions remain as thin wrappers, actual CLI calls delegated to provider
5. **Explicit override mechanism** — Project metadata `vcs_platform` field allows manual platform selection for edge cases

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Project standard, handles TypeScript natively |
| VCS CLIs | `gh` (GitHub), `glab` (GitLab) | Official CLIs with comprehensive API coverage |
| Platform detection | git CLI + string matching | No external dependencies, leverages existing git operations |
| Type system | TypeScript interfaces | Compile-time guarantees, IDE autocomplete, refactoring safety |
| Testing | Bun test + mocks | Project standard, fast execution, easy CLI mocking |

**Dependencies:**

- **Existing:** `gh` CLI (installed)
- **New:** `glab` CLI (must be installed for GitLab support)
- **No new npm packages** — pure abstraction over existing tools

## Data Model

### VCS Provider Interface

```typescript
// src/vcs/types.ts

export type VCSPlatform = 'github' | 'gitlab';

export interface VCSProvider {
  platform: VCSPlatform;

  // Pull/Merge Request operations
  createMR(opts: CreateMROptions): Promise<MRResult>;
  mergeMR(cwd: string, mrNumber: number): Promise<boolean>;
  getMRState(cwd: string, mrNumber: number): Promise<MRState | null>;
  getMRDiff(cwd: string, mrNumber: number): Promise<string>;
  getMRFiles(cwd: string, mrNumber: number): Promise<string[]>;

  // Review operations
  postReviewComment(cwd: string, mrNumber: number, body: string): Promise<void>;
  submitReview(
    cwd: string,
    mrNumber: number,
    event: ReviewEvent,
    body: string
  ): Promise<void>;
  fetchReviews(cwd: string, mrNumber: number): Promise<Review[]>;
  fetchInlineComments(cwd: string, mrNumber: number): Promise<InlineComment[]>;

  // Issue operations
  commentOnIssue(cwd: string, issueNumber: number, body: string): Promise<void>;
  getIssueStatus(ownerRepo: string, issueNumber: number): Promise<IssueStatus | null>;

  // API escape hatch
  api<T>(endpoint: string, timeoutMs?: number): Promise<T>;
}

export interface CreateMROptions {
  cwd: string;
  title: string;
  body: string;
  base: string;
  head?: string; // defaults to current branch
}

export interface MRResult {
  number: number;
  url: string;
}

export type MRState = 'MERGED' | 'OPEN' | 'CLOSED';
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES';

export interface Review {
  id: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED';
  body: string;
  author: string;
  submittedAt: string;
}

export interface InlineComment {
  id: string;
  path: string;
  line: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface IssueStatus {
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string;
  author: string;
  labels: string[];
}
```

### Platform Detection

```typescript
// src/vcs/detect.ts

export async function detectPlatform(projectPath: string): Promise<VCSPlatform> {
  const remoteUrl = await git(['remote', 'get-url', 'origin'], projectPath);

  // GitLab detection
  if (remoteUrl.includes('gitlab.com') || remoteUrl.includes('gitlab.')) {
    return 'gitlab';
  }

  // Default to GitHub
  return 'github';
}
```

### Provider Factory

```typescript
// src/vcs/index.ts

export async function getProvider(
  projectPath: string,
  projectMetadata?: Record<string, any>
): Promise<VCSProvider> {
  // 1. Check explicit override
  const explicitPlatform = projectMetadata?.vcs_platform as VCSPlatform | undefined;
  if (explicitPlatform) {
    return createProvider(explicitPlatform, projectPath);
  }

  // 2. Auto-detect from git remote
  const detected = await detectPlatform(projectPath);
  return createProvider(detected, projectPath);
}

function createProvider(platform: VCSPlatform, projectPath: string): VCSProvider {
  switch (platform) {
    case 'github':
      return new GitHubProvider(projectPath);
    case 'gitlab':
      return new GitLabProvider(projectPath);
  }
}
```

### Blackboard Schema Extension

No new tables required. Extend existing `projects` table metadata:

```typescript
// Project metadata (JSON column)
{
  "vcs_platform": "gitlab" | "github" // optional override
}
```

## API Contracts

### Provider Method Signatures

All provider methods are asynchronous and follow error propagation via exceptions.

**createMR:**
- Input: `CreateMROptions` (cwd, title, body, base, head?)
- Output: `{ number: number, url: string }`
- Side effect: Creates PR/MR on remote platform
- Error: Throws if CLI fails, branch doesn't exist, or auth fails

**mergeMR:**
- Input: `(cwd, mrNumber)`
- Output: `boolean` (success/failure)
- Side effect: Merges and deletes source branch
- Error: Throws if merge conflicts, MR not found, or insufficient permissions

**getMRState:**
- Input: `(cwd, mrNumber)`
- Output: `'MERGED' | 'OPEN' | 'CLOSED' | null`
- Error: Returns `null` if MR not found, throws on CLI failure

**submitReview:**
- Input: `(cwd, mrNumber, event: 'APPROVE' | 'REQUEST_CHANGES', body)`
- Output: `void`
- Side effect: Posts review on remote platform
- GitLab caveat: `REQUEST_CHANGES` maps to note with prefix for parser detection

**api\<T>:**
- Input: `(endpoint, timeoutMs?)`
- Output: `T` (parsed JSON response)
- Error: Throws on non-200 response or JSON parse failure

### CLI Command Mappings

All provider methods ultimately invoke CLI commands. Here's the translation layer:

| Operation | GitHub (`gh`) | GitLab (`glab`) |
|-----------|--------------|-----------------|
| Create PR/MR | `gh pr create --title "$TITLE" --body "$BODY" --base "$BASE"` | `glab mr create --title "$TITLE" --description "$BODY" --target-branch "$BASE"` |
| Merge | `gh pr merge $N --squash --delete-branch` | `glab mr merge $N --squash --remove-source-branch --yes` |
| Get state | `gh pr view $N --json state --jq .state` | `glab mr view $N --output json` (parse `.state`) |
| Diff | `gh pr diff $N` | `glab mr diff $N` |
| List files | `gh pr view $N --json files --jq '.files[].path'` | `glab mr diff $N --name-only` |
| Approve | `gh pr review $N --approve --body "$BODY"` | `glab mr approve $N && glab mr note $N --message "$BODY"` |
| Request changes | `gh pr review $N --request-changes --body "$BODY"` | `glab mr note $N --message "Changes requested: $BODY"` |
| Issue comment | `gh issue comment $N --body "$BODY"` | `glab issue note $N --message "$BODY"` |
| API call | `gh api $ENDPOINT` | `glab api $ENDPOINT` |

### URL Parsing

Both providers must extract MR/PR number from URLs:

```typescript
// GitHub: https://github.com/owner/repo/pull/123
const githubRegex = /github\.com\/[^\/]+\/[^\/]+\/pull\/(\d+)/;

// GitLab: https://gitlab.com/namespace/project/-/merge_requests/123
const gitlabRegex = /gitlab\.com\/[^\/]+\/[^\/]+\/-\/merge_requests\/(\d+)/;
```

## Implementation Phases

### Phase 1: Foundation (Types & Detection)
**File:** `src/vcs/types.ts`
- Define `VCSProvider` interface
- Define all supporting types (`CreateMROptions`, `MRResult`, `Review`, etc.)
- Export `VCSPlatform` union type

**File:** `src/vcs/detect.ts`
- Implement `detectPlatform(projectPath)` using git remote URL parsing
- Add unit tests for GitHub/GitLab/self-hosted detection

**Duration:** ~30 minutes

### Phase 2: GitHub Provider (Extract Existing)
**File:** `src/vcs/github-provider.ts`
- Implement `GitHubProvider` class
- Extract existing `gh()` helper from `worktree.ts` into provider
- Extract existing `ghApi()` logic from `pr-comments.ts` into provider
- Implement all `VCSProvider` interface methods
- Add unit tests with mocked `gh` CLI

**Duration:** ~1 hour

### Phase 3: Provider Factory
**File:** `src/vcs/index.ts`
- Implement `getProvider(projectPath, metadata)` factory
- Priority: metadata override → auto-detection → default GitHub
- Export provider factory and re-export types
- Add unit tests for factory logic

**Duration:** ~20 minutes

### Phase 4: GitLab Provider (New)
**File:** `src/vcs/gitlab-provider.ts`
- Implement `GitLabProvider` class using `glab` CLI
- Map all interface methods to `glab` commands per CLI mapping table
- Handle GitLab-specific quirks (REQUEST_CHANGES → note, project ID vs path)
- Add installation check: throw clear error if `glab` not found
- Add unit tests with mocked `glab` CLI

**Duration:** ~1.5 hours

### Phase 5: Refactor worktree.ts
**File:** `src/scheduler/worktree.ts`
- Remove `gh()` helper (now in GitHubProvider)
- Add `provider: VCSProvider` parameter to all PR-related functions
- Replace direct `gh` calls with `provider.createMR()`, `provider.mergeMR()`, etc.
- Keep `git()` helper unchanged (platform-independent)
- Preserve existing function signatures as thin wrappers for backwards compatibility
- Update unit tests to inject mock provider

**Duration:** ~45 minutes

### Phase 6: Refactor pr-comments.ts → vcs-comments.ts
**File:** `src/scheduler/pr-comments.ts` (or rename to `vcs-comments.ts`)
- Remove `ghApi()` helper (now in providers)
- Add `provider: VCSProvider` parameter
- Replace API calls with `provider.api()`, `provider.fetchInlineComments()`, etc.
- Update imports in dependent files
- Update unit tests

**Duration:** ~30 minutes

### Phase 7: Refactor review-agent.ts
**File:** `src/scheduler/review-agent.ts`
- Add `provider: VCSProvider` parameter to review agent launcher
- Replace hardcoded `gh pr diff` in prompt with `provider.getMRDiff()`
- Replace `gh pr view` with `provider.getMRState()`
- Update review prompt template to be platform-agnostic (use "PR/MR" terminology)

**Duration:** ~20 minutes

### Phase 8: Refactor github-issue-watcher.ts → issue-watcher.ts
**File:** `src/evaluators/github-issue-watcher.ts`
- Rename to `issue-watcher.ts`
- Add `provider: VCSProvider` parameter
- Replace `gh api` calls with `provider.getIssueStatus()`, `provider.commentOnIssue()`
- Update registration in evaluator registry
- Update unit tests

**Duration:** ~20 minutes

### Phase 9: Wire into Dispatch Pipeline
**Files:**
- `src/scheduler/scheduler.ts`
- `src/commands/dispatch-worker.ts`
- `src/scheduler/specflow-runner.ts`
- `src/scheduler/rework.ts`
- `src/scheduler/merge-fix.ts`
- `src/scheduler/pr-merge.ts`

**Changes:**
- Initialize provider at dispatch start: `const provider = await getProvider(project.local_path, project.metadata)`
- Thread provider through all handler calls (implement, review, rework, merge, etc.)
- Update function signatures to accept `provider` parameter
- No logic changes, pure plumbing

**Duration:** ~1 hour

### Phase 10: Unit Tests
**Files:**
- `tests/vcs/github-provider.test.ts`
- `tests/vcs/gitlab-provider.test.ts`
- `tests/vcs/detect.test.ts`
- `tests/vcs/factory.test.ts`

**Coverage:**
1. Provider factory — auto-detection, explicit override, fallback
2. GitHub provider — all methods produce correct `gh` commands
3. GitLab provider — all methods produce correct `glab` commands
4. URL parsing — extract numbers from both URL formats
5. Review mapping — APPROVE and REQUEST_CHANGES translate correctly
6. Error handling — missing CLI, failed commands, invalid inputs

**Duration:** ~2 hours

### Phase 11: Integration Test
**File:** `tests/integration/dispatch-gitlab.test.ts`

Simulate full dispatch cycle with mocked `glab` CLI:
1. Project registration with GitLab remote
2. Feature creation → implement phase → PR creation
3. Review phase → approval
4. Merge phase → MR merge
5. Issue watcher with GitLab issue

**Duration:** ~1 hour

### Phase 12: Documentation & Migration Guide
**Files:**
- `docs/vcs-providers.md` — Architecture overview, adding new providers
- `docs/gitlab-setup.md` — How to configure GitLab projects, `glab` installation
- Update existing dispatch pipeline docs with GitLab examples

**Duration:** ~30 minutes

**Total estimated duration:** ~9-10 hours

## File Structure

```
src/
├── vcs/                                    # New: VCS abstraction layer
│   ├── types.ts                            #   Provider interface, shared types
│   ├── detect.ts                           #   Platform auto-detection
│   ├── index.ts                            #   Provider factory
│   ├── github-provider.ts                  #   GitHub implementation (wraps gh)
│   └── gitlab-provider.ts                  #   GitLab implementation (wraps glab)
│
├── scheduler/
│   ├── worktree.ts                         # Modified: Use VCSProvider, remove gh() helper
│   ├── pr-comments.ts                      # Modified: Use provider.api(), remove ghApi()
│   ├── review-agent.ts                     # Modified: Accept provider parameter
│   ├── scheduler.ts                        # Modified: Initialize provider, thread through handlers
│   ├── rework.ts                           # Modified: Accept provider parameter
│   ├── pr-merge.ts                         # Modified: Accept provider parameter (minimal change)
│   ├── merge-fix.ts                        # Modified: Accept provider parameter (minimal change)
│   └── specflow-runner.ts                  # Modified: Pass provider to createPR()
│
├── commands/
│   └── dispatch-worker.ts                  # Modified: Initialize provider, pass to handlers
│
├── evaluators/
│   └── issue-watcher.ts                    # Modified: Renamed from github-issue-watcher.ts, use provider
│       (formerly github-issue-watcher.ts)
│
tests/
├── vcs/                                    # New: VCS provider unit tests
│   ├── github-provider.test.ts
│   ├── gitlab-provider.test.ts
│   ├── detect.test.ts
│   └── factory.test.ts
│
└── integration/                            # New: Full dispatch cycle integration tests
    └── dispatch-gitlab.test.ts
```

**File count:**
- New files: 10 (5 src, 5 test)
- Modified files: 10 (scheduler, commands, evaluators)

## Dependencies

### Runtime Dependencies

**Existing:**
- `gh` CLI (GitHub) — already installed and configured
- Bun runtime — project standard
- `git` CLI — used for worktree and remote operations

**New:**
- `glab` CLI (GitLab) — required for GitLab support
  - Installation: `brew install glab` (macOS), `apt install glab` (Linux)
  - Authentication: `glab auth login` (interactive OAuth flow)

**No new npm packages** — pure abstraction over existing CLIs.

### Development Dependencies

No changes — uses existing Bun test framework.

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **`glab` CLI not installed** | High — GitLab support broken | Medium | Provider initialization checks CLI availability, throws clear error with installation instructions. Document in setup guide. |
| **`glab` CLI incompatible version** | Medium — commands may fail | Low | Pin minimum `glab` version in docs. Add version check in provider initialization. |
| **Self-hosted GitLab URL detection fails** | Medium — wrong provider selected | Low | Explicit `vcs_platform` override in project metadata. Document override pattern. |
| **GitLab API differences break assumptions** | High — review/issue operations fail | Medium | Comprehensive unit tests per provider. Integration test with mocked `glab`. Early validation with real GitLab project. |
| **Review model mismatch (REQUEST_CHANGES)** | Low — review semantics differ | High | Documented in spec. GitLab provider maps to note with prefix. Evaluator adjusted if needed. |
| **Authentication differences** | Medium — dispatch fails on auth | Low | Both CLIs use OAuth tokens stored locally. Provider initialization validates auth state. |
| **Breaking existing GitHub projects** | **Critical** — regression | Low | GitHub provider wraps existing `gh()` logic. Extensive regression tests. Gradual rollout (GitLab opt-in initially). |
| **Mixed repository setups (submodules)** | Low — wrong provider per repo | Very Low | Provider per project, not global. Each dispatch initializes correct provider. |
| **URL parsing edge cases** | Low — can't extract PR/MR number | Low | Regex tested against real URLs. Fallback: extract from CLI output. |
| **Performance overhead (extra CLI call)** | Very Low — minor latency increase | Medium | Platform detection cached per dispatch cycle. Negligible impact (<100ms). |

### Critical Risk: Breaking GitHub Projects

**Mitigation strategy:**
1. **Extract, don't rewrite** — GitHub provider wraps existing `gh()` and `ghApi()` logic verbatim
2. **Regression test suite** — Run all existing dispatch tests against GitHub provider
3. **Backwards compatibility layer** — Keep function signatures in `worktree.ts` unchanged (thin wrappers)
4. **Gradual rollout:**
   - Phase 1: GitLab support opt-in (explicit `vcs_platform` override)
   - Phase 2: Auto-detection enabled after validation
   - Phase 3: Full rollout
5. **Monitoring** — Log provider initialization, track failures by platform

### Authentication Validation

Both `gh` and `glab` require authenticated sessions. Provider initialization should verify auth state:

```typescript
// In provider constructor
async validateAuth(): Promise<void> {
  if (this.platform === 'github') {
    await exec('gh auth status'); // throws if not authenticated
  } else {
    await exec('glab auth status'); // throws if not authenticated
  }
}
```

Throw clear error with authentication instructions if validation fails.

## Platform-Specific Considerations

### GitLab Quirks

1. **Project identifier** — GitLab uses numeric project ID or `namespace/project` path. The provider resolves this internally from the git remote URL. For API calls requiring project ID, use `glab api` with path format (CLI handles resolution).

2. **Request Changes semantics** — GitLab has no formal "request changes" review state. The `GitLabProvider.submitReview()` method maps this to a note with a parseable prefix: `"Changes requested: ..."`. If the evaluator needs to detect requested changes, it searches for this prefix in MR notes.

3. **Self-approval** — GitLab allows self-approval by default (configurable per project). The dispatch pipeline should not assume self-review is blocked like on GitHub.

4. **Squash merge** — Both platforms support squash merging. GitLab uses `--squash` + `--remove-source-branch` flags.

5. **API pagination** — GitLab API returns paginated results for large MR comment lists. The provider should handle pagination if fetching review comments (use `glab api` with `--paginate` flag if available).

### GitHub Quirks (for symmetry)

1. **Self-review blocked** — GitHub prevents approving your own PR. The dispatch pipeline already handles this (review agent doesn't review its own changes).

2. **Review dismissal** — GitHub allows dismissing stale reviews. Not currently used in dispatch pipeline, but could be added if needed.

3. **Draft PRs** — GitHub supports draft PRs. The provider's `createMR()` could accept a `draft: boolean` option if this is needed.

## Testing Strategy

### Unit Tests (per provider)

**GitHub Provider:**
- Mock `gh` CLI calls using Bun's subprocess mocking
- Verify correct command construction for all operations
- Test error handling (CLI failure, non-zero exit, missing fields)
- Test URL parsing (various GitHub URL formats)

**GitLab Provider:**
- Mock `glab` CLI calls
- Verify correct command construction (different flags from `gh`)
- Test review mapping (APPROVE → approve + note, REQUEST_CHANGES → note)
- Test URL parsing (GitLab URL format with `/-/merge_requests/`)

**Factory & Detection:**
- Test auto-detection from various remote URLs (github.com, gitlab.com, self-hosted)
- Test explicit override via metadata
- Test default fallback (GitHub)
- Test mixed project setup (multiple projects with different platforms)

### Integration Tests

**Full dispatch cycle:**
1. Register GitLab project
2. Create feature, generate spec
3. Run implement phase → verify `glab mr create` called
4. Run review phase → verify `glab mr diff`, `glab mr approve` called
5. Run merge phase → verify `glab mr merge` called
6. Issue watcher → verify `glab api` issue fetch

**Regression tests:**
- Run existing GitHub dispatch tests with GitHub provider
- Verify no behavior changes, no new failures

### Manual Validation

Before release, manually test with real GitLab project:
1. Clone a GitLab repository
2. Register in blackboard
3. Run full dispatch cycle (implement → review → merge)
4. Verify PR creation, review comments, merge success on GitLab UI

## Rollout Plan

### Phase 1: Opt-in (v0.1.0)
- GitLab support available via explicit `vcs_platform: 'gitlab'` metadata field
- Auto-detection disabled (always defaults to GitHub unless overridden)
- Documentation: "Experimental GitLab support"
- Target: Internal testing with 1-2 GitLab projects

### Phase 2: Auto-detection (v0.2.0)
- Enable auto-detection from git remote URL
- GitHub remains default for unknown remotes
- Documentation: "GitLab support (beta)"
- Target: Broader testing with 5-10 projects

### Phase 3: Full rollout (v1.0.0)
- GitLab support considered stable
- Documentation: "Full GitHub and GitLab support"
- Monitoring: Track provider distribution, error rates by platform

### Rollback Plan

If critical issues arise:
1. Add feature flag: `DISABLE_GITLAB_SUPPORT=1` env var
2. Factory defaults to GitHub provider regardless of detection
3. Document rollback in release notes
4. Fix issues, re-enable in next release

## Future Extensions

This architecture supports adding new VCS platforms:

1. **Bitbucket** — Implement `BitbucketProvider` using `bb` CLI or API
2. **Azure DevOps** — Implement `AzureProvider` using `az repos` CLI
3. **Gitea/Forgejo** — Self-hosted Git forges with API clients

Adding a new provider requires:
1. Implement `VCSProvider` interface
2. Update `VCSPlatform` union type
3. Update `detectPlatform()` for auto-detection
4. Add provider to factory
5. Add unit and integration tests
6. Document CLI installation and authentication

The existing dispatch pipeline code remains unchanged — new providers plug in via the factory.

---

[PHASE COMPLETE: PLAN]
Feature: F-023
Plan: .specify/specs/f-023-gitlab-cli-support-for-dispatch-pipeline/plan.md
