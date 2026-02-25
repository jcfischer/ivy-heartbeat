# F-023: GitLab CLI Support for Dispatch Pipeline

## Summary

F-023 adds VCS provider abstraction to the SpecFlow dispatch pipeline, enabling seamless support for both GitHub and GitLab without duplicating pipeline logic. The system now auto-detects the VCS platform from git remote URLs and routes operations through the appropriate CLI (`gh` for GitHub, `glab` for GitLab).

**Key capabilities:**
- Automatic platform detection from git remote URL (github.com, gitlab.com)
- Explicit override via project metadata `vcs_platform` field
- Unified interface for PR/MR operations across both platforms
- Zero changes to existing pipeline logic — abstraction layer handles platform differences

## What Changed

### Files Added

**VCS Provider Abstraction (`src/vcs/`):**
- `types.ts` — `VCSProvider` interface and shared types
- `detect.ts` — Platform auto-detection from git remote URL
- `index.ts` — Provider factory (`getProvider`)
- `github-provider.ts` — GitHub implementation wrapping `gh` CLI
- `gitlab-provider.ts` — GitLab implementation wrapping `glab` CLI

**Planning & Documentation:**
- `.specify/specs/f-023-gitlab-cli-support-for-dispatch-pipeline/plan.md` — Full technical plan (630 lines)
- `.specify/specs/f-023-gitlab-cli-support-for-dispatch-pipeline/tasks.md` — Implementation task breakdown (594 lines)
- `Plans/goofy-inventing-llama.md` — Development planning session (420 lines)
- `CHANGELOG.md` — Release note entry

### Files Modified

**None** — This feature adds new infrastructure but doesn't modify existing files. The plan outlines future integration points where `scheduler/worktree.ts`, `scheduler/review-agent.ts`, and other dispatch components will be refactored to use the new provider abstraction.

## Architecture

### Provider Pattern

The implementation uses the Strategy pattern:

```
Dispatch Pipeline
      ↓
  getProvider(projectPath, metadata)
      ↓
  VCSProvider interface
      ↓
   ┌──────┴──────┐
   ↓             ↓
GitHubProvider  GitLabProvider
   ↓             ↓
  gh CLI       glab CLI
```

### Platform Detection

Auto-detection priority:
1. **Explicit override** — `vcs_platform` in project metadata (blackboard)
2. **Git remote URL** — Parse `git remote get-url origin`
   - Contains `gitlab.com` or `gitlab.` → GitLab
   - Otherwise → GitHub (default)
3. **Fallback** — GitHub

### Provider Interface

All platform-specific operations abstracted behind `VCSProvider`:

```typescript
interface VCSProvider {
  platform: 'github' | 'gitlab';

  // PR/MR operations
  createMR(opts: CreateMROptions): Promise<{ number, url }>;
  mergeMR(cwd, mrNumber): Promise<boolean>;
  getMRState(cwd, mrNumber): Promise<'MERGED'|'OPEN'|'CLOSED'|null>;
  getMRDiff(cwd, mrNumber): Promise<string>;
  getMRFiles(cwd, mrNumber): Promise<string[]>;

  // Review operations
  postReviewComment(cwd, mrNumber, body): Promise<void>;
  submitReview(cwd, mrNumber, event, body): Promise<void>;
  fetchReviews(cwd, mrNumber): Promise<Review[]>;
  fetchInlineComments(cwd, mrNumber): Promise<InlineComment[]>;

  // Issue operations
  commentOnIssue(cwd, issueNumber, body): Promise<void>;
  getIssueStatus(ownerRepo, issueNumber): Promise<IssueStatus|null>;

  // API escape hatch
  api<T>(endpoint, timeoutMs?): Promise<T>;
}
```

## Configuration

### For GitHub Projects (default)

No configuration needed — existing behavior preserved.

### For GitLab Projects

**Option 1: Auto-detection (recommended)**

If your git remote URL contains `gitlab.com`, the system auto-detects:

```bash
git remote get-url origin
# → git@gitlab.com:namespace/project.git
# Auto-detected as GitLab ✓
```

**Option 2: Explicit override**

For self-hosted GitLab or edge cases, set project metadata:

```bash
blackboard project register \
  --name my-project \
  --path /path/to/repo \
  --metadata '{"vcs_platform": "gitlab"}'
```

Or update existing project:

```typescript
// In blackboard DB projects table metadata column:
{
  "vcs_platform": "gitlab"
}
```

### Prerequisites

**For GitLab support:**
1. Install `glab` CLI:
   ```bash
   # macOS
   brew install glab

   # Linux
   apt install glab  # or distro equivalent
   ```

2. Authenticate:
   ```bash
   glab auth login
   # Follow OAuth flow
   ```

3. Verify:
   ```bash
   glab auth status
   # ✓ Logged in to gitlab.com as username
   ```

## Usage

### Dispatch Pipeline Integration

Once this feature is fully integrated (future phases), dispatch operations will automatically route through the correct provider:

```typescript
// In scheduler or dispatch worker
const provider = await getProvider(project.local_path, project.metadata);

// Create PR/MR
const { number, url } = await provider.createMR({
  cwd: worktreePath,
  title: 'feat: implement feature',
  body: prBody,
  base: 'main'
});

// Merge
await provider.mergeMR(worktreePath, number);

// Review
await provider.submitReview(worktreePath, number, 'APPROVE', 'LGTM');
```

### CLI Command Mappings

| Operation | GitHub (`gh`) | GitLab (`glab`) |
|-----------|--------------|-----------------|
| Create PR/MR | `gh pr create --title T --body B --base main` | `glab mr create --title T --description B --target-branch main` |
| Merge | `gh pr merge N --squash --delete-branch` | `glab mr merge N --squash --remove-source-branch --yes` |
| Approve | `gh pr review N --approve --body B` | `glab mr approve N && glab mr note N --message B` |
| Diff | `gh pr diff N` | `glab mr diff N` |
| Issue comment | `gh issue comment N --body B` | `glab issue note N --message B` |

## Platform Differences

### Review Model

**GitHub:**
- Formal review states: APPROVE, REQUEST_CHANGES, COMMENT
- Self-review blocked by platform

**GitLab:**
- Binary approvals (approve/unapprove)
- "Request changes" mapped to note with prefix for parsing
- Self-approval may be allowed (project-configurable)

### URL Formats

- **GitHub:** `https://github.com/owner/repo/pull/123`
- **GitLab:** `https://gitlab.com/namespace/project/-/merge_requests/123`

### Terminology

The codebase uses "PR" terminology for backwards compatibility, but methods are named generically (`createMR`, `mergeMR`) to reflect both platforms.

## Testing

### Implementation Status

This feature adds the foundation but integration is incomplete. Future phases will:
1. Refactor `scheduler/worktree.ts` to use providers
2. Update `scheduler/review-agent.ts` for provider-aware prompts
3. Wire providers into all dispatch handlers

### Planned Test Coverage

- Platform auto-detection (github.com, gitlab.com, self-hosted)
- Explicit metadata override
- GitHub provider wraps existing `gh` commands (regression)
- GitLab provider generates correct `glab` commands
- URL parsing for both platforms
- Review event mapping (APPROVE, REQUEST_CHANGES)
- Full dispatch cycle integration test

## Future Work

### Remaining Integration Points

1. **worktree.ts** — Replace `gh()` helper with provider methods
2. **review-agent.ts** — Make review prompts provider-aware
3. **pr-comments.ts** → **vcs-comments.ts** — Generalize comment handling
4. **github-issue-watcher.ts** → **issue-watcher.ts** — Platform-agnostic issue watching
5. **Scheduler & dispatch-worker** — Initialize and thread provider through handlers

### Potential Extensions

- **Bitbucket** support via `bb` CLI
- **Azure DevOps** support via `az repos` CLI
- **Gitea/Forgejo** self-hosted support

Adding new platforms requires:
1. Implement `VCSProvider` interface
2. Update platform detection
3. Add to factory
4. Add tests

## Migration Notes

**Backwards Compatibility:**
- Existing GitHub projects unchanged
- No action required for current users
- GitLab support opt-in initially

**When Integration Complete:**
- All dispatch operations will automatically use correct provider
- Project detection happens transparently
- Manual override available for edge cases

## References

- **Spec:** `.specify/specs/f-023-gitlab-cli-support-for-dispatch-pipeline/spec.md`
- **Plan:** `.specify/specs/f-023-gitlab-cli-support-for-dispatch-pipeline/plan.md`
- **Tasks:** `.specify/specs/f-023-gitlab-cli-support-for-dispatch-pipeline/tasks.md`
