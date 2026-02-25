# Implementation Plan: F-023 GitLab CLI Support for Dispatch Pipeline

## Overview

Add VCS provider abstraction to support both GitHub (`gh` CLI) and GitLab (`glab` CLI) in the dispatch pipeline. The existing codebase is GitHub-only with hardcoded `gh()` helpers in `worktree.ts`. This refactoring will:

1. Extract GitHub logic into a provider implementation
2. Create provider interface and factory
3. Add GitLab provider implementation
4. Thread provider through dispatch pipeline
5. Maintain 100% backward compatibility with existing GitHub workflows

**Estimated Duration:** 8-10 hours across 52 tasks (see tasks.md)

---

## Exploration Summary

### Current GitHub CLI Usage

**Core Files:**
- `src/scheduler/worktree.ts` - `gh()` helper (line 126), PR operations
- `src/scheduler/pr-comments.ts` - `ghApi()` helper (line 37), comment fetching
- `src/scheduler/review-agent.ts` - GitHub commands in prompts
- `src/evaluators/github-issue-watcher.ts` - Issue state watching
- 10+ files total with direct GitHub CLI usage

**Existing Patterns:**
- Injectable providers with `set/reset` functions for testing
- Bun.spawn subprocess execution with stdout/stderr capture
- AbortController for timeout handling (30s default)
- Module-level helpers exported from worktree.ts

**Test Patterns:**
- Dependency injection preferred over mocking libraries
- Unit tests with mocked providers
- Integration tests with real git operations
- Test files: `test/<feature>.test.ts`

### Dispatch Pipeline Integration Points

**Entry Points:**
1. `scheduler.ts:dispatch()` - main orchestration
2. `dispatch-worker.ts` - fire-and-forget subprocess worker
3. `specflow-runner.ts` - SpecFlow phase execution

**Handler Flow:**
```
dispatch() → query work items → resolve project → init VCS provider
  ├→ SpecFlow handler (runSpecFlowPhase)
  ├→ MergeFix handler (runMergeFix)
  ├→ Rework handler (runRework)
  ├→ Review handler (dispatchReviewAgent)
  ├→ PR Merge handler (runPRMerge)
  └→ Reflect handler (handleReflectWorkItem)
```

**Project Metadata Access:**
- `bb.getProject(item.project_id)` returns `{ project_id, name, local_path, metadata, remote_repo }`
- `metadata` is JSON blob for configuration
- Accessed in scheduler.ts:271, rework.ts:95, dispatch-worker.ts:404

---

## Recommended Approach

### 1. VCS Provider Architecture

**Provider Interface** (`src/vcs/types.ts`):
```typescript
export type VCSPlatform = 'github' | 'gitlab';

export interface VCSProvider {
  platform: VCSPlatform;

  // PR/MR operations
  createMR(opts: CreateMROptions): Promise<MRResult>;
  mergeMR(cwd: string, mrNumber: number): Promise<boolean>;
  getMRState(cwd: string, mrNumber: number): Promise<MRState | null>;
  getMRDiff(cwd: string, mrNumber: number): Promise<string>;
  getMRFiles(cwd: string, mrNumber: number): Promise<string[]>;

  // Review operations
  postReviewComment(cwd: string, mrNumber: number, body: string): Promise<void>;
  submitReview(cwd: string, mrNumber: number, event: ReviewEvent, body: string): Promise<void>;
  fetchReviews(cwd: string, mrNumber: number): Promise<Review[]>;
  fetchInlineComments(cwd: string, mrNumber: number): Promise<InlineComment[]>;

  // Issue operations
  commentOnIssue(cwd: string, issueNumber: number, body: string): Promise<void>;
  getIssueStatus(ownerRepo: string, issueNumber: number): Promise<IssueStatus | null>;

  // API escape hatch
  api<T>(endpoint: string, timeoutMs?: number): Promise<T>;
}
```

**Factory Pattern** (`src/vcs/index.ts`):
```typescript
export async function getProvider(
  projectPath: string,
  projectMetadata?: Record<string, any>
): Promise<VCSProvider> {
  // Priority: metadata.vcs_platform → auto-detect → default github
  const platform = projectMetadata?.vcs_platform
    ?? await detectPlatform(projectPath)
    ?? 'github';

  return createProvider(platform, projectPath);
}
```

### 2. Implementation Strategy

**Phase 1: Foundation (Parallel - 1 hour)**
- T-1.1: Define VCS types and provider interface
- T-1.2: Implement platform detection from git remote URL
- T-4.1: Create GitLab provider class structure

**Phase 2: GitHub Provider (Sequential - 2 hours)**
- Extract existing `gh()` helper from worktree.ts
- Extract `ghApi()` from pr-comments.ts
- Implement all interface methods by wrapping existing code
- This preserves 100% backward compatibility

**Phase 3: Provider Factory (30 min)**
- Implement getProvider() with auto-detection
- Add error handling for missing CLI

**Phase 4: GitLab Provider (Sequential - 2 hours)**
- Implement all interface methods using `glab` CLI
- Map review semantics (REQUEST_CHANGES → note)
- Handle GitLab-specific quirks (project ID, approvals)

**Phase 5: Refactor worktree.ts (Critical - 1 hour)**
- Replace `gh()` calls with `provider.createMR()`, etc.
- Add `provider: VCSProvider` parameter to all PR functions
- Keep `git()` helper unchanged (platform-independent)

**Phase 6: Thread Through Pipeline (2 hours)**
- Initialize provider in scheduler.ts after `bb.getProject()`
- Pass through all handlers (runSpecFlowPhase, runRework, etc.)
- Update dispatch-worker.ts with same pattern

**Phase 7: Testing (2 hours)**
- Unit tests for both providers with mocked CLI
- Integration tests with real git operations
- Regression tests for GitHub (ensure no breaks)

### 3. Critical Files to Modify

**New Files (10):**
```
src/vcs/
├── types.ts           # Provider interface, types
├── detect.ts          # Platform auto-detection
├── index.ts           # Factory
├── github-provider.ts # GitHub implementation
└── gitlab-provider.ts # GitLab implementation

tests/vcs/
├── github-provider.test.ts
├── gitlab-provider.test.ts
├── detect.test.ts
├── factory.test.ts
└── integration/
    └── dispatch-gitlab.test.ts
```

**Modified Files (10):**
- `src/scheduler/worktree.ts` - Remove `gh()` helper, add provider parameter
- `src/scheduler/pr-comments.ts` - Remove `ghApi()`, add provider parameter
- `src/scheduler/review-agent.ts` - Use provider methods
- `src/scheduler/scheduler.ts` - Initialize provider
- `src/commands/dispatch-worker.ts` - Initialize provider
- `src/scheduler/specflow-runner.ts` - Pass provider
- `src/scheduler/rework.ts` - Accept provider
- `src/scheduler/pr-merge.ts` - Accept provider
- `src/scheduler/merge-fix.ts` - Accept provider
- `src/evaluators/github-issue-watcher.ts` → `issue-watcher.ts` - Use provider

### 4. Project Metadata Extension

**Schema Addition:**
```json
{
  "vcs_platform": "gitlab",  // optional: "github" | "gitlab"
  "vcs_config": {
    "api_token_env": "GITLAB_TOKEN",
    "default_branch": "main"
  }
}
```

**Access Pattern:**
```typescript
// In scheduler.ts and dispatch-worker.ts
const project = item.project_id ? bb.getProject(item.project_id) : null;
const provider = project
  ? await getProvider(project.local_path, JSON.parse(project.metadata || '{}'))
  : await getProvider(resolvedWorkDir);  // fallback

// Pass to handlers
await runSpecFlowPhase(bb, item, { project_id, local_path, provider }, sessionId);
```

### 5. Testing Strategy

**Unit Tests (Injectable Mocks):**
```typescript
// test/vcs-github.test.ts
let mockProvider: VCSProvider;
let apiCalls: Array<{ method: string; args: any[] }>;

beforeEach(() => {
  apiCalls = [];
  mockProvider = createMockGitHubProvider((method, args) => {
    apiCalls.push({ method, args });
  });
});

test('createMR calls gh pr create with correct args', async () => {
  await mockProvider.createMR({ cwd: '/tmp', title: 'Test', body: '', base: 'main' });
  expect(apiCalls[0].method).toBe('spawn');
  expect(apiCalls[0].args).toContain('pr');
  expect(apiCalls[0].args).toContain('create');
});
```

**Integration Tests (Real CLI):**
```typescript
// test/integration/dispatch-gitlab.test.ts
test('full dispatch cycle with GitLab provider', async () => {
  // Requires glab CLI installed
  if (!hasGlabCLI()) test.skip();

  const bb = createTestBlackboard();
  const project = bb.registerProject({
    name: 'test-gitlab',
    local_path: '/tmp/test-repo',
    metadata: JSON.stringify({ vcs_platform: 'gitlab' }),
  });

  // Create work item → dispatch → verify MR created on GitLab
  const item = bb.createWorkItem({ source: 'specflow', project_id: project.project_id });
  await dispatch(bb, { maxItems: 1 });

  // Verify via glab CLI
  const mrState = await exec('glab mr view 1 --output json');
  expect(JSON.parse(mrState).state).toBe('opened');
});
```

### 6. Risk Mitigation

**Critical Risk: Breaking GitHub Workflows**

**Mitigation:**
1. GitHub provider wraps existing code verbatim (no logic changes)
2. Add `provider` parameter as optional initially
3. Comprehensive regression test suite
4. Test against real GitHub project before merge

**CLI Not Installed:**
```typescript
// In provider constructor
async validateAuth(): Promise<void> {
  try {
    if (this.platform === 'github') {
      await exec('gh auth status');
    } else {
      await exec('glab auth status');
    }
  } catch (err) {
    throw new Error(
      `${this.platform} CLI not installed or not authenticated.\n` +
      `Install: brew install ${this.platform === 'github' ? 'gh' : 'glab'}\n` +
      `Authenticate: ${this.platform === 'github' ? 'gh' : 'glab'} auth login`
    );
  }
}
```

### 7. GitLab-Specific Considerations

**Command Mapping:**
| GitHub | GitLab | Notes |
|--------|--------|-------|
| `gh pr create` | `glab mr create --title T --description B` | Different flags |
| `gh pr merge --squash` | `glab mr merge --squash --remove-source-branch` | Similar |
| `gh pr review --approve` | `glab mr approve` + `glab mr note` | Split operations |
| `gh pr review --request-changes` | `glab mr note --message "Changes requested: ..."` | No formal state |
| `gh api /repos/.../pulls/N/reviews` | `glab api /projects/:id/merge_requests/N/approvals` | Different endpoint |

**Review Semantics:**
- GitHub: APPROVE/CHANGES_REQUESTED/COMMENT states
- GitLab: Binary approve/unapprove, REQUEST_CHANGES → note with prefix

**Project Identifier:**
- GitHub: `owner/repo`
- GitLab: project ID or `namespace/project`

### 8. Backward Compatibility

**Existing Signatures Preserved:**
```typescript
// worktree.ts - before
export async function createPR(cwd: string, title: string, body: string, base: string, head?: string): Promise<PRResult>

// worktree.ts - after (add optional provider)
export async function createPR(
  cwd: string,
  title: string,
  body: string,
  base: string,
  head?: string,
  provider?: VCSProvider  // NEW - optional, defaults to GitHub
): Promise<PRResult>
```

**Gradual Rollout:**
1. Implement with optional provider parameter
2. Test with GitHub provider (should be identical to old behavior)
3. Enable GitLab support via explicit metadata override
4. Enable auto-detection after validation

---

## Verification Plan

### End-to-End Test (GitHub - Regression)

1. Register GitHub project (existing ivy-heartbeat)
2. Create SpecFlow feature from GitHub issue
3. Run implement phase → verify PR created on GitHub
4. Run review phase → verify gh pr review called
5. Run merge phase → verify PR merged
6. Confirm: no behavior changes from pre-refactor

### End-to-End Test (GitLab - New)

1. Clone GitLab test repository
2. Register in blackboard with `vcs_platform: 'gitlab'` metadata
3. Create SpecFlow feature
4. Run implement phase → verify MR created on GitLab
5. Run review phase → verify glab mr approve called
6. Run merge phase → verify MR merged on GitLab

### Unit Test Coverage

- GitHub provider: all 11 interface methods
- GitLab provider: all 11 interface methods
- Factory: auto-detection, explicit override, error handling
- Detection: github.com, gitlab.com, self-hosted, unknown

---

## Implementation Sequencing

**Day 1 (4 hours):**
- Foundation (T-1.1, T-1.2, T-4.1) - 1 hour
- GitHub provider extraction (T-2.1 through T-2.11) - 2 hours
- Provider factory (T-3.1, T-3.2) - 30 min
- Initial tests - 30 min

**Day 2 (3 hours):**
- GitLab provider (T-4.2 through T-4.6) - 2 hours
- Refactor worktree.ts (T-5.1, T-5.2) - 1 hour

**Day 3 (3 hours):**
- Thread through pipeline (T-9.1 through T-9.6) - 1.5 hours
- Refactor supporting modules (T-6.x, T-7.x, T-8.x) - 1.5 hours

**Day 4 (2 hours):**
- Comprehensive testing (T-10.x) - 1 hour
- Manual validation (T-12.x) - 1 hour

---

## Key Functions to Reuse

**From worktree.ts:**
- `git(args: string[], cwd: string): Promise<string>` - Keep unchanged (line 102)
- `gh(args: string[], cwd: string): Promise<string>` - Extract into GitHubProvider (line 126)

**From pr-comments.ts:**
- `ghApi<T>(endpoint: string, timeoutMs?: number): Promise<T>` - Extract into GitHubProvider (line 37)

**From scheduler.ts:**
- `bb.getProject(item.project_id)` - Use for provider initialization (line 271)

**Existing Injectable Pattern:**
```typescript
// github-issues.ts pattern to follow
let issueFetcher: IssueFetcher = defaultIssueFetcher;
export function setIssueFetcher(f: IssueFetcher): void { issueFetcher = f; }
export function resetIssueFetcher(): void { issueFetcher = defaultIssueFetcher; }
```

---

## Success Criteria

- ✅ All existing tests pass (no regressions)
- ✅ GitHub provider works identically to pre-refactor
- ✅ GitLab provider passes all interface tests
- ✅ Factory correctly detects platform from git remote
- ✅ Manual validation: full cycle on both GitHub and GitLab projects
- ✅ Documentation complete (architecture, setup guides)
- ✅ No new npm dependencies (pure CLI abstraction)

---

## Next Steps

1. **Create feature branch** (already exists: `specflow-f-023`)
2. **Start with T-1.1** (VCS types)
3. **Follow TDD** (write test → implement → verify)
4. **Track progress** in tasks.md progress table
5. **Run full test suite** after each task group
