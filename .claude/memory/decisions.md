# Decisions Log

## 2026-02-26 - F-027 Phase 3: queued phase handled via advance
- Decision: `queued` ends with 'ed', so `determineAction()` routes it through `advance` (queued → specifying), not `run-phase`
- Rationale: Consistent with the state machine — `queued` is a seed state like `specified`. The `SpecifyExecutor.canRun()` only handles `specifying` (and `specifying` retry), not `queued`.
- Commit: 5bf6726

## 2026-02-24 - Claude OAuth for subprocess auth
- Decision: Use `CLAUDE_CODE_OAUTH_TOKEN` env var (from `claude setup-token`) instead of keychain scraping or `ANTHROPIC_API_KEY`
- Rationale: `claude --print` subprocesses need auth. API credits are depleted. The keychain OAuth token (`sk-ant-oat01-...`) doesn't work as `ANTHROPIC_API_KEY` (different format). `claude setup-token` creates a long-lived token specifically for headless use, passed via `CLAUDE_CODE_OAUTH_TOKEN`.
- Alternatives rejected: (1) Keychain scraping — OAuth tokens expire every ~6h, wrong env var. (2) `ANTHROPIC_API_KEY` with OAuth token — "Invalid API key" error, different auth mechanism. (3) API credits — depleted, costs money.
- Implementation: Token stored in `.env` (gitignored), Bun auto-loads it, launcher passes `process.env` to subprocess which includes the token.

## 2026-02-25 - Implement→complete phase restructure
- Decision: Split implement and complete into separate chained phases; PR creation happens in complete phase
- Rationale: User specified PR should be created AFTER specflow complete runs, not during implement. Changed `PHASE_TRANSITIONS implement: null` → `implement: 'complete'`. Simplified handleImplementPhase to only commit; new handleCompletePhase handles push/PR/review.
- Alternatives rejected: Keeping inline complete within implement — violated user's design intent

## 2026-02-25 - ANTHROPIC_API_KEY suppression: empty string (CORRECTED)
- Decision: Set `ANTHROPIC_API_KEY: ''` (empty string) in launcher subprocess env when `CLAUDE_CODE_OAUTH_TOKEN` is available
- Rationale: The `claude` CLI is Bun-compiled with `--compile-autoload-dotenv` — it loads `.env` from its CWD. `undefined` removes the key from subprocess env, but the CLI's autoloader refills it from the target project's `.env` (which may have a depleted key). Empty string `''` is present (prevents `.env` override) but falsy (Claude Code skips it, falls through to OAuth).
- Alternatives rejected: (1) `undefined` — Bun.spawn strips it, then autoloader refills from CWD `.env`. (2) `'SUPPRESSED_FOR_OAUTH'` — Claude Code uses it as an actual API key → "Invalid API key". (3) Not setting it at all — same problem as `undefined`.
- Previous entry was wrong: the earlier session tested `''` but with a stale binary. This session proved `''` is the correct approach via systematic testing.

## 2026-02-25 - Unconditional re-review work item creation after rework
- Decision: Create re-review work item regardless of whether `commitAll()` returns a SHA
- Rationale: Rework agents commit and push inside their Claude session. Post-agent `commitAll()` finds nothing → SHA is null → re-review was skipped. Pattern: don't gate downstream work items on commit status.
- Alternatives rejected: Preventing agent from doing git ops — too restrictive, breaks agent autonomy

## 2026-02-24 - Max OAuth for SpecFlow specify/plan/tasks phases
- Decision: Route specify/plan/tasks through Max-authenticated launcher instead of specflow's internal `claude -p`
- Rationale: specflow's `claude -p` uses API credits (no Max OAuth). The implement phase already used the launcher correctly. Added `SPECFLOW_PROMPT_OUTPUT` env var to headless.ts — specflow writes prompt JSON to file and exits, then ivy-heartbeat's `runPhaseViaLauncher()` reads it and uses the Max launcher.
- Alternatives rejected: (1) Passing Max OAuth tokens to specflow's env — fragile, couples auth. (2) Modifying specflow to use SDK directly — larger change, breaks standalone usage.
- Status: Committed and pushed (2026-02-25)

## 2026-02-25 - Replace compiled binaries with shell wrappers (all 3 projects)
- Decision: All binaries (ivy-heartbeat, specflow, ivy-blackboard) now use `exec bun src/index.ts "$@"` wrappers instead of `bun build --compile`
- Rationale: Eliminates three bug classes: (1) binary out of date after code changes, (2) Bun compiler Bus errors in compiled mode, (3) manual .env loading hack needed for compiled binaries. All tools run on the developer's machine, so Bun is always available.
- Alternatives rejected: Keeping compiled binary with better rebuild automation — still has Bun compiler bugs and .env issues

## 2026-02-25 - specflow-queue: advance DB phases to match existing artifacts
- Decision: When `specflow-queue` detects existing spec artifacts on disk, automatically advance the specflow DB phase via `specflow phase <id> <phase>` for each completed phase
- Rationale: Without this, the runner's prerequisite check blocks dispatch because the DB is at "none" while artifacts exist. Also auto-fixes spec_path entries ending in `.md` (should be directory, not file).
- Alternatives rejected: Relaxing the prerequisite check in the runner — that check is a safety net against stale retries

## 2026-02-25 - Add PR merge handler to fire-and-forget dispatch-worker
- Decision: Added `parsePRMergeMeta`/`runPRMerge` to dispatch-worker.ts (matching scheduler.ts)
- Rationale: Merge work items in fire-and-forget mode fell through to generic Claude launcher → "Credit balance is too low". PR merges only need `gh pr merge` (no Claude at all).
- Alternatives rejected: Routing all merges through synchronous dispatch — fire-and-forget is the normal path

## 2026-02-25 - Add rework and code_review to content filter TRUSTED_SOURCES
- Decision: Added `'rework'` and `'code_review'` to `TRUSTED_SOURCES` in `ivy-blackboard/src/ingestion.ts`
- Rationale: After fixing auth, review agents posted successfully but writing rework work items to blackboard failed — `source: 'rework'` triggered the content filter. Review summaries contain camelCase code identifiers (`setMetricsReporter`, `DbMetricsQueryAdapter`) that false-positive the base64 detector. These are internal pipeline sources (not external user content) and should be trusted.
- Alternatives rejected: (1) Fixing the base64 detector — correct long-term but higher effort. (2) Stripping code identifiers from review summaries — loses useful information.
- Note: This reverses the earlier decision (2026-02-23) that rejected adding `code_review` to TRUSTED_SOURCES. The defense-in-depth concern is addressed by the evaluator layer's pre-filtering.

## 2026-02-23 - Fix PR review evaluator content filter false positive
- Decision: Remove raw GitHub URL from work item description; keep URL only in `sourceRef` field
- Rationale: The `pai-content-filter` base64 detector false-positives on GitHub URL paths like `com/jcfischer/supertag` (looks like base64 chars). Removing URL from description body avoids the filter while keeping the URL accessible via `sourceRef`.
- Alternatives rejected: (1) Adding `code_review` to TRUSTED_SOURCES — rejected because external PRs could carry malicious content in titles/branch names. (2) Fixing the base64 detector in pai-content-filter — correct long-term fix but higher effort, tracked separately.

## 2026-02-22 - Session Memory Initialized
- Decision: Created `.claude/memory/` directory with decisions.md and session-log.md
- Rationale: Required by project CLAUDE.md protocol
- Alternatives rejected: None — first session with this protocol

## 2026-02-26 - F-027 Phase 1: specflow_features table in ivy-blackboard
- Decision: Add table to both `CREATE_TABLES_SQL` (fresh DBs) AND as `MIGRATE_V6_SQL` (existing DBs at v5)
- Rationale: Fresh DB creation skips migrations entirely — table must exist in initial schema. Migration handles the upgrade path for existing deployments.
- Files changed: `src/schema.ts` (CREATE_TABLES_SQL, CREATE_INDEXES_SQL, MIGRATE_V6_SQL, CURRENT_SCHEMA_VERSION=6), `src/db.ts` (migration registry), `src/types.ts` (SpecFlowFeature interface + types), `src/specflow-features.ts` (new CRUD module), `tests/specflow-features.test.ts` (24 tests)
- Commit: `422f872` in ivy-blackboard
- Tests: 424/424 pass
- Key pattern: `getActionableFeatures()` returns: (1) all active features (timeout checks), (2) pending features within slot budget, (3) over-limit features (need fail marking)

## 2026-02-26 - F-027 SpecFlow State Machine Redesign
- Decision: Centralized `specflow_features` table in ivy-blackboard + single orchestrator replaces work-item phase chaining
- Rationale: Work items are wrong abstraction for multi-phase pipelines — decentralized state creates 7 failure modes (FM-1 through FM-7)
- 5-phase migration: add DB table → dual-write → orchestrator → feature-flag switchover → cleanup
- Spec committed at b499a4b: `.specify/specs/f-027-specflow-state-machine-redesign/`
- Phase naming: `*ing` = active, `*ed` = completed — queryable with LIKE patterns
- Feature flag: `SPECFLOW_ORCHESTRATOR=true/false` for safe rollback

## 2026-02-26 - F-027 Phase 2: Dual-Write Bridge
- Decision: All writes to `specflow_features` wrapped in try/catch — pipeline behavior unchanged
- Key patterns: `ensureFeatureRow()` creates row if missing (covers pre-Phase-2 items); `evalScore` captured with `let` before quality gate block to avoid scoping issues; type casts needed for `phase` and `status` fields (`as SpecFlowFeature['phase']`)
- Bun workspace gotcha: Adding new files to ivy-blackboard requires `bun install` in ivy-heartbeat to refresh per-file symlinks in node_modules
- Commit: `c57aa63` — 5 files, 224 insertions
- Next: Phase 3 (centralized orchestrator that dispatches based on specflow_features table)
