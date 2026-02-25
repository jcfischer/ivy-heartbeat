# Changelog

All notable changes to ivy-heartbeat are documented here.

## [Unreleased]

### Added
- **Implement→complete phase pipeline** — `implement` and `complete` are now separate chained phases; PR creation and review dispatch happen in the `complete` phase after specflow validation
- **`hasCommitsAhead()` check** — skips push/PR when branch has no new commits vs base
- **`--head` flag for `gh pr create`** — fixes branch detection in git worktrees
- **`.env` loading for compiled binaries** — manual `.env` parsing at startup since Bun only auto-loads in dev mode

### Fixed
- Suppress `ANTHROPIC_API_KEY` with empty string `''` in subprocess env to force OAuth authentication — prevents Bun's `--compile-autoload-dotenv` from loading depleted keys from target project `.env` files
- OAuth token propagation to all subprocess launches (review agents, specflow phases)
- Complete phase validation failures no longer block PR creation — code gets reviewed regardless
- Branch name detection uses `getCurrentBranch()` instead of hardcoded `specflow-{featureId}` pattern
- Review result parser uses last match to prevent prompt template text from overriding actual agent output
- Review prompt template uses non-parseable placeholders to prevent false regex matches
- Quality gate parses JSON output before checking exit code (specflow eval exits 1 for below-threshold scores)
- Handle missing prompt file when specflow phase artifact already exists

### Changed
- SpecFlow eval commands use `spawnSync` with array args instead of `execSync` to avoid shell metacharacter interpretation
- `PHASE_TRANSITIONS` updated: `implement` now chains to `complete` (was terminal)

## [0.1.0] - 2026-02-24

### Added
- **Autonomous dispatch pipeline** — claim work items from blackboard, dispatch to Claude Code agents, handle results
- **SpecFlow integration** — full phase orchestration (specify → plan → tasks → implement → complete) with quality gates
- **Max OAuth launcher routing** — specify/plan/tasks phases route through Max OAuth (no API credits)
- **AI code review agent** — reviews PRs against specs using 7 dimensions, posts GitHub reviews
- **Rework cycle management** — review → fix → re-review loop with configurable max cycles (default: 2)
- **PR merge automation** — merges approved PRs after successful code review
- **Merge conflict resolution** — dedicated agent for resolving merge conflicts
- **Git worktree lifecycle** — isolated worktrees per work item with auto-cleanup
- **GitHub PR review evaluator** — checks PR review status in the check pipeline
- **Content filter integration** — filters work item content through pai-content-filter
- **Code duplication detection** — review agent enforces no-duplication policy
- **Web dashboard** — real-time agent monitoring, work item tracking, event stream
- **Native binary compilation** — `build.sh` compiles to standalone binary via `bun build --compile`

### Fixed
- Guard rework and review agents against closed/merged PRs (#25, #28)
- Skip merge-fix work item creation when PR is already merged (#22, #23)
- Detect uncommitted changes in worktree before implement phase launch (#20)
- Phase prerequisite check prevents specflow infinite retry loop
- Validate phase artifacts exist after specflow exits zero
- Retry work item creation with stripped body when ingestion filter blocks
- Backfill empty work item metadata and infer GitHub context from source_ref
- Strip CLAUDECODE env var for spawned agent processes
- Sync untracked spec artifacts from source repo to worktree
- Symlink specflow DB from source repo to worktree
- Keep serve process alive in compiled binary
