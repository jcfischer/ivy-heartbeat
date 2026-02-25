# F-023: GitLab CLI Support for Dispatch Pipeline

## Summary

This feature adds GitLab support to the SpecFlow dispatch pipeline (PR creation, merge, review, issue watching, rework, merge-fix) which was previously hardcoded to use GitHub's `gh` CLI. A VCS provider abstraction now allows the pipeline to work interchangeably with both GitHub (`gh`) and GitLab (`glab`) CLIs. The platform is auto-detected from the git remote URL or can be explicitly configured per project.

## What Changed

### New Files Added

**VCS Provider Abstraction Layer:**
- `src/vcs/types.ts` — `VCSProvider` interface and shared types
- `src/vcs/detect.ts` — Platform auto-detection from git remote URL
- `src/vcs/index.ts` — Provider factory (`getProvider()`)
- `src/vcs/github-provider.ts` — GitHub implementation wrapping `gh` CLI
- `src/vcs/gitlab-provider.ts` — GitLab implementation wrapping `glab` CLI

**Tests:**
- `tests/vcs/github-provider.test.ts` — GitHub provider unit tests
- `tests/vcs/gitlab-provider.test.ts` — GitLab provider unit tests
- `tests/vcs/detect.test.ts` — Platform detection tests
- `tests/vcs/factory.test.ts` — Factory logic tests
- `tests/integration/dispatch-gitlab.test.ts` — Full GitLab dispatch cycle integration test

### Modified Files

**Core Pipeline:**
- `src/scheduler/worktree.ts` — Replaced `gh()` helper with `VCSProvider` methods
- `src/scheduler/pr-comments.ts` — Replaced `ghApi()` with `provider.api()`
- `src/scheduler/review-agent.ts` — Made review prompt provider-aware
- `src/scheduler/scheduler.ts` — Initialize provider at dispatch start
- `src/scheduler/rework.ts` — Accept provider parameter
- `src/scheduler/pr-merge.ts` — Accept provider parameter
- `src/scheduler/merge-fix.ts` — Accept provider parameter
- `src/scheduler/specflow-runner.ts` — Pass provider to `createPR()` calls
- `src/commands/dispatch-worker.ts` — Initialize provider, pass to handlers
- `src/evaluators/issue-watcher.ts` — Renamed from `github-issue-watcher.ts`, use provider for issue operations

## Configuration

### Auto-Detection

The platform is automatically detected from the git remote URL:
- URLs containing `gitlab.com` or `gitlab.` → GitLab
- Default → GitHub

### Explicit Override

For self-hosted GitLab instances or custom domains, add a `vcs_platform` field to the project metadata in the blackboard:

```json
{
  "vcs_platform": "gitlab"
}
```

This can be set when registering a project:

```bash
blackboard project register --name "my-gitlab-project" \
  --path /path/to/project \
  --metadata '{"vcs_platform": "gitlab"}'
```

## Setup Requirements

### GitLab Support

**Install `glab` CLI:**
```bash
# macOS
brew install glab

# Linux
apt install glab
```

**Authenticate:**
```bash
glab auth login
```

Follow the interactive OAuth flow to authenticate with GitLab.

### GitHub Support (Existing)

No changes needed. The `gh` CLI is already installed and authenticated.

## Usage

### Dispatch Pipeline

The dispatch pipeline now works identically for both GitHub and GitLab projects:

```bash
# Create a feature and start dispatch
specflow create F-123 "My feature"
specflow implement F-123

# The pipeline auto-detects the platform and uses the appropriate CLI:
# - GitHub projects → uses `gh pr create`, `gh pr merge`, etc.
# - GitLab projects → uses `glab mr create`, `glab mr merge`, etc.
```

### Review Phase

Reviews work the same way regardless of platform:

```bash
specflow review F-123
```

The review agent:
- Fetches the PR/MR diff using the appropriate CLI
- Posts review comments
- Submits approval or change requests

### Platform-Specific Behavior

**GitLab Quirks:**
- GitLab has no formal "request changes" review state. Change requests are mapped to notes with a parseable prefix: `"Changes requested: ..."`.
- GitLab allows self-approval by default (configurable per project).

**GitHub Behavior (Unchanged):**
- Formal review states (APPROVE, CHANGES_REQUESTED, COMMENT)
- Self-review is blocked

## Verification

To verify the feature is working:

1. **Check platform detection:**
   ```bash
   cd /path/to/gitlab/project
   git remote get-url origin
   # Should show gitlab.com or gitlab.* in URL
   ```

2. **Test PR/MR creation:**
   ```bash
   specflow implement F-XXX
   # Verify MR is created on GitLab web UI
   ```

3. **Test review cycle:**
   ```bash
   specflow review F-XXX
   # Verify review comments appear on GitLab MR
   ```

4. **Test merge:**
   ```bash
   specflow merge F-XXX
   # Verify MR is merged and source branch removed
   ```

## Architecture

The VCS provider abstraction uses a strategy pattern:

```
┌─────────────────────────────────────┐
│     Dispatch Pipeline               │
│  (scheduler, dispatch-worker)       │
└────────────┬────────────────────────┘
             │
             │ getProvider(projectPath, metadata)
             ▼
      ┌──────────────┐
      │ VCSProvider  │ ◄─── Interface
      └──────────────┘
             △
             │
      ┌──────┴──────┐
      │             │
┌─────▼─────┐ ┌────▼──────┐
│  GitHub   │ │  GitLab   │
│ Provider  │ │ Provider  │
└─────┬─────┘ └────┬──────┘
      │            │
      ▼            ▼
  ┌───────┐    ┌──────┐
  │gh CLI │    │glab  │
  └───────┘    └──────┘
```

**Platform Detection Priority:**
1. Project metadata `vcs_platform` override
2. Git remote URL detection
3. Default: GitHub

## Future Extensions

The architecture supports adding new VCS platforms (Bitbucket, Azure DevOps, Gitea, etc.) by implementing the `VCSProvider` interface. The existing dispatch pipeline code remains unchanged.
