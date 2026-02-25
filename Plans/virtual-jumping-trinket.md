# Implementation Plan: F-023 GitLab CLI Support for Dispatch Pipeline

## Context

The SpecFlow dispatch pipeline currently hardcodes all PR/MR operations to GitHub's `gh` CLI. This plan introduces a VCS provider abstraction layer to support both GitHub and GitLab interchangeably, with automatic platform detection from git remote URLs and optional explicit configuration.

## Architecture Overview

### Current State
```
scheduler.ts → worktree.ts → gh() helper → Bun.spawn(['gh', ...])
                           → git() helper → Bun.spawn(['git', ...])
```

### Target State
```
scheduler.ts → worktree.ts → VCSProvider interface → GitHubProvider → gh CLI
                                                   → GitLabProvider → glab CLI
                           → git() helper (unchanged)
```

### Key Design Decisions

1. **Provider Interface Location**: `src/vcs/` directory (already exists with types.ts and detect.ts)
2. **Threading Strategy**: Pass provider as parameter through call chain (Option 1 from exploration)
   - Initialize once at dispatch start in `scheduler.ts` and `dispatch-worker.ts`
   - Thread through handler functions (runSpecFlowPhase, runRework, runMergeFix, runPRMerge, dispatchReviewAgent)
   - Pass to worktree.ts functions (createPR, mergePR, getPRState, etc.)
3. **Backward Compatibility**: Keep existing function signatures as thin wrappers, add provider parameter as last argument
4. **Testing Strategy**: Follow existing patterns - injectable mocks for unit tests, real CLI for integration tests

## Critical Files & Modifications

### New Files (5 total)

1. **`src/vcs/github-provider.ts`** - GitHub implementation
   - Extract gh() helper from worktree.ts
   - Extract ghApi() helper from pr-comments.ts
   - Implement all VCSProvider interface methods

2. **`src/vcs/gitlab-provider.ts`** - GitLab implementation
   - Implement glab() helper analogous to gh()
   - Map all operations to glab CLI commands
   - Handle GitLab-specific review semantics (REQUEST_CHANGES → note)

3. **`src/vcs/index.ts`** - Provider factory
   - Implement getProvider(projectPath, metadata) with priority: metadata override → auto-detect → default GitHub
   - Re-export types from types.ts

4. **`tests/vcs/github-provider.test.ts`** - GitHub provider unit tests
   - Mock gh CLI calls using existing patterns
   - Test all interface methods

5. **`tests/vcs/gitlab-provider.test.ts`** - GitLab provider unit tests
   - Mock glab CLI calls
   - Test review event mapping

### Modified Files (10 total)

#### Core VCS Operations
1. **`src/scheduler/worktree.ts`** (CRITICAL PATH)
   - Remove gh() helper (move to GitHubProvider)
   - Add provider parameter to: createPR, mergePR, getPRState, getDiffSummary, fetchPRFiles
   - Replace gh() calls with provider.createMR(), provider.mergeMR(), etc.
   - Keep git() helper unchanged

2. **`src/scheduler/pr-comments.ts`**
   - Remove ghApi() helper (move to GitHubProvider)
   - Add provider parameter to fetchPRComments()
   - Replace ghApi() with provider.api(), provider.fetchInlineComments()

#### Pipeline Orchestration
3. **`src/scheduler/scheduler.ts`** (PRIMARY ENTRY POINT)
   - Import getProvider from vcs/index
   - Initialize provider at line ~200: `const provider = await getProvider(project.local_path, project.metadata)`
   - Thread through all handler calls (runSpecFlowPhase, runRework, runMergeFix, runPRMerge, dispatchReviewAgent)

4. **`src/commands/dispatch-worker.ts`** (WORKER ENTRY POINT)
   - Import getProvider
   - Initialize provider at line ~390
   - Thread through handler calls

#### Handler Functions
5. **`src/scheduler/specflow-runner.ts`**
   - Add provider parameter to runSpecFlowPhase()
   - Pass to createPR() in handleCompletePhase() at line ~1367

6. **`src/scheduler/rework.ts`**
   - Add provider parameter to runRework()
   - Pass to worktree functions

7. **`src/scheduler/merge-fix.ts`**
   - Add provider parameter to runMergeFix()
   - Pass to getPRState(), mergePR(), pullMain()

8. **`src/scheduler/pr-merge.ts`**
   - Add provider parameter to runPRMerge()
   - Pass to mergePR(), pullMain()

#### Review Operations
9. **`src/scheduler/review-agent.ts`**
   - Add provider parameter to dispatchReviewAgent() and buildReviewPrompt()
   - Replace hardcoded gh commands in prompt template with provider-aware commands

10. **`src/evaluators/github-issue-watcher.ts`** → **`issue-watcher.ts`**
    - Rename file to be platform-agnostic
    - Add provider parameter
    - Replace gh api calls with provider.getIssueStatus(), provider.commentOnIssue()

## Implementation Sequence (TDD Approach)

### Phase 1: Foundation (T-1.1, T-1.2)
**Duration: 30 minutes**

1. **Test First**: Create `tests/vcs/detect.test.ts`
   - Test github.com URL detection
   - Test gitlab.com URL detection
   - Test self-hosted GitLab detection
   - Test default fallback

2. **Implementation**: Already exists in `src/vcs/detect.ts` - verify functionality

3. **Test First**: Create skeleton unit tests in `tests/vcs/github-provider.test.ts`
   - Test structure for createMR, mergeMR, getMRState methods

4. **Implementation**: Create `src/vcs/github-provider.ts` class structure

### Phase 2: GitHub Provider (T-2.1 through T-2.11)
**Duration: 1 hour**

1. **Extract gh() helper** from worktree.ts into GitHubProvider
   - Copy lines 102-144 (gh function and related helpers)
   - Make it a private method
   - Keep same error handling and timeout patterns

2. **Extract ghApi() helper** from pr-comments.ts into GitHubProvider
   - Copy timeout/abort controller pattern
   - Make it a private method

3. **Implement each VCSProvider method** following TDD:
   ```typescript
   // Test
   test('createMR calls gh pr create with correct args', async () => {
     const provider = new GitHubProvider();
     await provider.createMR({...});
     expect(mockCliCalls).toContain(['pr', 'create', '--title', ...]);
   });

   // Implementation
   async createMR(opts: CreateMROptions): Promise<MRResult> {
     const output = await this.gh(['pr', 'create', '--title', opts.title, ...]);
     // parse and return
   }
   ```

4. **Add URL parsing** and **authentication validation**

### Phase 3: Provider Factory (T-3.1, T-3.2)
**Duration: 20 minutes**

1. **Test First**: Create `tests/vcs/factory.test.ts`
   - Test explicit metadata override
   - Test auto-detection fallback
   - Test default to GitHub

2. **Implementation**: Create `src/vcs/index.ts`
   ```typescript
   export async function getProvider(
     projectPath: string,
     projectMetadata?: Record<string, any>
   ): Promise<VCSProvider> {
     // 1. Check metadata override
     if (projectMetadata?.vcs_platform) {
       return createProvider(projectMetadata.vcs_platform, projectPath);
     }
     // 2. Auto-detect
     const detected = await detectPlatform(projectPath);
     return createProvider(detected, projectPath);
   }
   ```

### Phase 4: GitLab Provider (T-4.1 through T-4.6)
**Duration: 1.5 hours**

1. **Test First**: Create `tests/vcs/gitlab-provider.test.ts`
   - Test all interface methods with mocked glab CLI
   - Test review event mapping (APPROVE, REQUEST_CHANGES)

2. **Implementation**: Create `src/vcs/gitlab-provider.ts`
   - Implement glab() helper analogous to gh()
   - Map each VCSProvider method to glab commands:
     ```
     createMR → glab mr create --title --description --target-branch
     mergeMR → glab mr merge N --squash --remove-source-branch --yes
     getMRState → glab mr view N --output json
     ```
   - Handle REQUEST_CHANGES → note with prefix pattern

### Phase 5: Refactor worktree.ts (T-5.1 through T-5.3) **CRITICAL PATH**
**Duration: 1.5 hours**

1. **Update existing tests** in `tests/worktree.test.ts`:
   - Add provider parameter to test helper functions
   - Use injectable mock provider

2. **Refactor worktree.ts functions**:
   ```typescript
   // Before
   export async function createPR(
     worktreePath: string,
     title: string,
     body: string,
     base: string,
     head?: string
   ): Promise<{ number: number; url: string }> {
     const output = await gh(['pr', 'create', ...], worktreePath);
     // ...
   }

   // After
   export async function createPR(
     worktreePath: string,
     title: string,
     body: string,
     base: string,
     head?: string,
     provider: VCSProvider  // NEW PARAMETER
   ): Promise<{ number: number; url: string }> {
     const result = await provider.createMR({
       cwd: worktreePath,
       title,
       body,
       base,
       head
     });
     return result;
   }
   ```

3. **Update all callers** in scheduler.ts, dispatch-worker.ts, specflow-runner.ts, etc.

### Phase 6: Refactor Supporting Modules (T-6.1 through T-8.2)
**Duration: 1.5 hours**

1. **pr-comments.ts**: Add provider parameter, replace ghApi()
2. **review-agent.ts**: Add provider parameter, make prompts platform-aware
3. **issue-watcher.ts**: Rename from github-issue-watcher.ts, add provider

### Phase 7: Wire Dispatch Pipeline (T-9.1 through T-9.6)
**Duration: 1 hour**

1. **scheduler.ts**:
   ```typescript
   async function dispatch(bb: Blackboard, opts: DispatchOpts) {
     // ... existing setup ...

     // NEW: Initialize VCS provider
     const provider = await getProvider(project.local_path, project.metadata);

     // Thread through handlers
     if (specflowMeta) {
       await runSpecFlowPhase(bb, item, project, sessionId, provider);
     }
     if (reworkMeta) {
       await runRework(bb, item, reworkMeta, project, sessionId, launcher, timeoutMs, provider);
     }
     // ... etc for all handlers
   }
   ```

2. **dispatch-worker.ts**: Same pattern

### Phase 8: Comprehensive Testing (T-10.1 through T-10.5)
**Duration: 2 hours**

1. **Unit tests**: Verify all provider methods with mocked CLI
2. **Regression tests**: Run existing GitHub dispatch tests - must pass unchanged
3. **GitLab integration test**: Mock full dispatch cycle with glab CLI
4. **Factory tests**: Verify detection and override logic

### Phase 9: Manual Validation (T-12.1, T-12.2)
**Duration: 1 hour**

1. **GitHub validation**: Run real dispatch cycle, verify no regressions
2. **GitLab validation** (if glab installed): Run real dispatch cycle with GitLab project

## Testing Strategy

### Unit Tests (Mocked CLI)
```typescript
// Pattern from exploration
let cliCalls: Array<{ tool: string; args: string[] }> = [];

function mockGhCli(responses: Record<string, { exitCode: number; stdout: string }>) {
  return async (args: string[], cwd: string) => {
    cliCalls.push({ tool: 'gh', args });
    const key = args[0];
    const response = responses[key] ?? { exitCode: 0, stdout: '' };
    if (response.exitCode !== 0) throw new Error(`gh failed`);
    return response.stdout;
  };
}

// Inject into provider for testing
beforeEach(() => {
  cliCalls = [];
  setGhCliExecutor(mockGhCli({ /* responses */ }));
});
```

### Integration Tests (Real Git)
```typescript
// Pattern from worktree.test.ts
async function initTestRepo(): Promise<string> {
  const repoDir = mkdtempSync(join(tmpdir(), 'vcs-test-'));
  const run = async (args: string[]) => {
    const proc = Bun.spawn(['git', ...args], {
      cwd: repoDir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { GIT_AUTHOR_NAME: 'Test', ... }
    });
    await proc.exited;
  };
  await run(['init', '-b', 'main']);
  return repoDir;
}
```

## Verification Checklist

### Functional Verification
- [ ] GitHub provider creates PRs correctly
- [ ] GitLab provider creates MRs correctly
- [ ] Platform detection works for github.com, gitlab.com, self-hosted
- [ ] Provider factory respects metadata override
- [ ] Review operations map correctly (APPROVE, REQUEST_CHANGES)
- [ ] Issue watcher works with both platforms
- [ ] Full dispatch cycle works end-to-end with GitHub provider

### Quality Gates
- [ ] All existing GitHub dispatch tests pass (regression check)
- [ ] New GitLab provider tests pass
- [ ] Unit test coverage for all provider methods
- [ ] No new npm dependencies added
- [ ] TypeScript strict mode passes
- [ ] No test files modified except adding new ones

### Edge Cases
- [ ] Error when glab CLI not installed (clear error message)
- [ ] Error when gh CLI not authenticated
- [ ] Self-hosted GitLab with custom domain (metadata override)
- [ ] Mixed project setup (some GitHub, some GitLab)
- [ ] URL parsing handles both platform formats

## Risk Mitigation

### Critical Risk: Breaking GitHub Functionality
**Mitigation**:
- GitHub provider wraps existing gh() logic verbatim (extract, don't rewrite)
- Run full regression test suite before and after refactor
- Gradual rollout: test GitHub path first, add GitLab second

### Medium Risk: GitLab CLI Differences
**Mitigation**:
- Comprehensive CLI command mapping table in spec
- Unit tests for each command translation
- Document platform-specific quirks (REQUEST_CHANGES mapping)

### Low Risk: Platform Detection Edge Cases
**Mitigation**:
- Explicit metadata override as escape hatch
- Default to GitHub for unknown remotes
- Document override pattern in README

## Success Criteria

1. **Backward Compatibility**: All existing GitHub dispatch tests pass without modification
2. **Feature Complete**: GitLab provider implements all VCSProvider interface methods
3. **Test Coverage**: >90% coverage for new VCS provider code
4. **Documentation**: Clear error messages for CLI installation/auth failures
5. **Code Quality**: TypeScript strict mode, follows existing patterns

## Estimated Timeline

Total: **9-10 hours** (per technical plan)

- Foundation: 30 min
- GitHub Provider: 1 hour
- Factory: 20 min
- GitLab Provider: 1.5 hours
- Refactor worktree.ts: 1.5 hours (critical path)
- Supporting modules: 1.5 hours
- Pipeline wiring: 1 hour
- Testing: 2 hours
- Manual validation: 1 hour

## Files to Create/Modify Summary

**New Files (5)**:
- src/vcs/github-provider.ts
- src/vcs/gitlab-provider.ts
- src/vcs/index.ts
- tests/vcs/github-provider.test.ts
- tests/vcs/gitlab-provider.test.ts

**Modified Files (10)**:
- src/scheduler/worktree.ts (critical)
- src/scheduler/pr-comments.ts
- src/scheduler/scheduler.ts (primary entry)
- src/commands/dispatch-worker.ts (worker entry)
- src/scheduler/specflow-runner.ts
- src/scheduler/rework.ts
- src/scheduler/merge-fix.ts
- src/scheduler/pr-merge.ts
- src/scheduler/review-agent.ts
- src/evaluators/github-issue-watcher.ts → issue-watcher.ts
