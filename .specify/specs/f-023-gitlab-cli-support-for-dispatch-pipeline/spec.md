# F-023: GitLab CLI Support for Dispatch Pipeline

## Problem Statement

The SpecFlow dispatch pipeline (PR creation, merge, review, issue watching, rework, merge-fix) is hardcoded to the GitHub `gh` CLI. Projects hosted on GitLab cannot use the automated implement-review-merge cycle. This feature adds a VCS provider abstraction so the same pipeline works interchangeably with GitHub (`gh`) or GitLab (`glab`) CLIs, with platform auto-detected from the git remote URL or configurable per project.

## Users & Stakeholders

- **Primary user:** PAI operator managing projects on both GitHub and GitLab
- **Consumer:** Dispatch pipeline agents (implement, review, rework, merge)
- **Technical level:** Developer comfortable with CLI, TypeScript, SQLite

## Architecture

### Provider Interface

A `VCSProvider` interface abstracts all platform-specific operations. Two implementations: `GitHubProvider` (using `gh`) and `GitLabProvider` (using `glab`).

```typescript
interface VCSProvider {
  // Identity
  platform: 'github' | 'gitlab';

  // Pull/Merge Request operations
  createMR(opts: CreateMROptions): Promise<{ number: number; url: string }>;
  mergeMR(cwd: string, mrNumber: number): Promise<boolean>;
  getMRState(cwd: string, mrNumber: number): Promise<'MERGED' | 'OPEN' | 'CLOSED' | null>;
  getMRDiff(cwd: string, mrNumber: number): Promise<string>;
  getMRFiles(cwd: string, mrNumber: number): Promise<string[]>;

  // Review operations
  postReviewComment(cwd: string, mrNumber: number, body: string): Promise<void>;
  submitReview(cwd: string, mrNumber: number, event: 'APPROVE' | 'REQUEST_CHANGES', body: string): Promise<void>;
  fetchReviews(cwd: string, mrNumber: number): Promise<Review[]>;
  fetchInlineComments(cwd: string, mrNumber: number): Promise<InlineComment[]>;

  // Issue operations
  commentOnIssue(cwd: string, issueNumber: number, body: string): Promise<void>;
  getIssueStatus(ownerRepo: string, issueNumber: number): Promise<IssueStatus | null>;

  // API escape hatch
  api<T>(endpoint: string, timeoutMs?: number): Promise<T>;
}

interface CreateMROptions {
  cwd: string;
  title: string;
  body: string;
  base: string;
  head?: string;
}
```

### Platform Detection

```typescript
async function detectPlatform(projectPath: string): Promise<'github' | 'gitlab'> {
  const remoteUrl = await git(['remote', 'get-url', 'origin'], projectPath);
  if (remoteUrl.includes('gitlab.com') || remoteUrl.includes('gitlab.')) return 'gitlab';
  return 'github'; // default
}
```

Override via project metadata in blackboard: `vcs_platform: 'github' | 'gitlab'` field on the `projects` table.

### New Files

```
src/
├── vcs/
│   ├── types.ts              # VCSProvider interface, CreateMROptions, shared types
│   ├── github-provider.ts    # GitHub implementation (wraps existing gh() calls)
│   ├── gitlab-provider.ts    # GitLab implementation (wraps glab CLI)
│   ├── detect.ts             # Platform detection from git remote URL
│   └── index.ts              # Factory: getProvider(projectPath) → VCSProvider
```

### Modified Files

- `src/scheduler/worktree.ts` — Replace `gh()` helper and all `gh` CLI calls with `VCSProvider` methods. The `git()` helper stays (git is platform-independent). Export `createPR`, `mergePR`, `getPRState` as thin wrappers that delegate to the provider.
- `src/scheduler/review-agent.ts` — Replace hardcoded `gh pr diff`, `gh pr view` in review prompt with provider-aware commands.
- `src/scheduler/pr-comments.ts` — Replace `ghApi()` with `provider.api()`. Rename to `vcs-comments.ts` (or keep name for backwards compatibility).
- `src/evaluators/github-issue-watcher.ts` — Replace `gh api` issue fetching with `provider.getIssueStatus()`. Rename to `issue-watcher.ts`.
- `src/scheduler/pr-merge.ts` — No structural changes needed (uses `worktree.ts` functions). Terminology: keep "PR" in type names for backwards compatibility, but comments should say "PR/MR".
- `src/scheduler/rework.ts` — Uses `worktree.ts` functions, minimal changes. Review prompt references may need `gh`→provider adaptation.
- `src/scheduler/scheduler.ts` — Initialize provider at dispatch start, pass to handlers.
- `src/commands/dispatch-worker.ts` — Same: initialize provider, pass to handlers.
- `src/scheduler/specflow-runner.ts` — Pass provider to `createPR()` calls in complete phase.
- `src/scheduler/merge-fix.ts` — Uses `worktree.ts` functions, minimal changes.

## CLI Command Mapping

### PR/MR Operations

| Operation | GitHub (`gh`) | GitLab (`glab`) |
|-----------|--------------|-----------------|
| Create PR/MR | `gh pr create --title T --body B --base main` | `glab mr create --title T --description B --target-branch main` |
| Merge | `gh pr merge N --squash --delete-branch` | `glab mr merge N --squash --remove-source-branch --yes` |
| View state | `gh pr view N --json state --jq .state` | `glab mr view N --output json` → parse `.state` |
| Diff | `gh pr diff N` | `glab mr diff N` |
| Files list | `gh pr view N --json files` | `glab mr diff N --name-only` |
| Review approve | `gh pr review N --approve --body B` | `glab mr approve N` + `glab mr note N --message B` |
| Review request changes | `gh pr review N --request-changes --body B` | `glab mr note N --message B` (no native "request changes") |

### Issue Operations

| Operation | GitHub (`gh`) | GitLab (`glab`) |
|-----------|--------------|-----------------|
| Comment | `gh issue comment N --body B` | `glab issue note N --message B` |
| View status | `gh api /repos/OWNER/REPO/issues/N` | `glab api /projects/:id/issues/N` |
| List comments | `gh api /repos/OWNER/REPO/issues/N/comments` | `glab api /projects/:id/issues/N/notes` |

### API Calls

| Operation | GitHub (`gh`) | GitLab (`glab`) |
|-----------|--------------|-----------------|
| Generic API | `gh api /repos/OWNER/REPO/...` | `glab api /projects/:id/...` |
| PR review comments | `gh api /repos/.../pulls/N/comments` | `glab api /projects/:id/merge_requests/N/notes` |
| PR reviews | `gh api /repos/.../pulls/N/reviews` | `glab api /projects/:id/merge_requests/N/approvals` |

## GitLab-Specific Considerations

### Terminology
- GitHub: Pull Request (PR), Review, Approve/Request Changes
- GitLab: Merge Request (MR), Approval, Notes

The codebase keeps "PR" terminology in type names and metadata for backwards compatibility. The VCSProvider interface uses generic method names (`createMR`, `mergeMR`).

### Review Model Differences
- **GitHub:** Formal review states (APPROVE, CHANGES_REQUESTED, COMMENT). Self-review blocked.
- **GitLab:** Approvals are binary (approve/unapprove). "Request changes" is a note/comment, not a formal state. Self-approval may be allowed depending on project settings.

The `GitLabProvider.submitReview()` maps:
- `APPROVE` → `glab mr approve N` + optional note
- `REQUEST_CHANGES` → `glab mr note N --message "Changes requested: ..."` (prefix for parsing)

### Project Identifier
- GitHub uses `owner/repo` (e.g., `jcfischer/ivy-heartbeat`)
- GitLab uses project ID or `namespace/project` path

The provider handles this internally. The `ownerRepo` string in existing code maps to the appropriate identifier per platform.

### URL Parsing
- GitHub PR URL: `https://github.com/owner/repo/pull/123`
- GitLab MR URL: `https://gitlab.com/namespace/project/-/merge_requests/123`

Both providers extract the MR/PR number from their respective URL formats.

## Provider Initialization

```typescript
// In scheduler.ts / dispatch-worker.ts
const provider = await getProvider(project.local_path, project.metadata);

// getProvider checks:
// 1. Project metadata vcs_platform field (explicit override)
// 2. git remote URL detection (auto-detect)
// 3. Default: 'github'
```

## Blackboard Integration

### Project Metadata Extension

Add optional `vcs_platform` field to project metadata:

```json
{
  "vcs_platform": "gitlab"
}
```

This allows explicit override when auto-detection is insufficient (e.g., self-hosted GitLab on a custom domain).

### No New Event Types

The existing event types (`code_review.completed`, `lesson.created`, etc.) are platform-agnostic. No changes needed.

## Test Scenarios

1. **Provider factory** — auto-detect GitHub from `github.com` remote, GitLab from `gitlab.com` remote
2. **Provider factory** — explicit override via project metadata takes precedence
3. **GitHub provider** — all methods produce correct `gh` CLI commands (regression: existing behavior preserved)
4. **GitLab provider** — all methods produce correct `glab` CLI commands
5. **URL parsing** — extract MR/PR number from both URL formats
6. **Review mapping** — `APPROVE` and `REQUEST_CHANGES` map correctly for both platforms
7. **Issue watcher** — correctly fetches issue status from both platforms
8. **Integration** — full dispatch cycle (implement→review→rework→merge) works with GitLab provider
9. **Edge cases:**
   - Self-hosted GitLab with custom domain → explicit `vcs_platform` override
   - `glab` not installed → clear error message at provider initialization
   - Mixed project setup (some GitHub, some GitLab) → correct provider per project

## Implementation Order

1. VCS types and provider interface (`vcs/types.ts`)
2. GitHub provider (`vcs/github-provider.ts`) — extract existing `gh` calls from `worktree.ts` and `pr-comments.ts`
3. Platform detection (`vcs/detect.ts`)
4. Provider factory (`vcs/index.ts`)
5. GitLab provider (`vcs/gitlab-provider.ts`) — implement all methods using `glab` CLI
6. Refactor `worktree.ts` — replace `gh()` calls with provider methods
7. Refactor `pr-comments.ts` — replace `ghApi()` with provider
8. Refactor `review-agent.ts` — make review prompt provider-aware
9. Refactor `github-issue-watcher.ts` → `issue-watcher.ts` — use provider
10. Wire provider into `scheduler.ts` and `dispatch-worker.ts`
11. Unit tests for both providers
12. Integration test with mock `glab` CLI
