# Ivy Heartbeat

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/jcfischer/ivy-heartbeat/actions/workflows/ci.yml/badge.svg)](https://github.com/jcfischer/ivy-heartbeat/actions/workflows/ci.yml)

Proactive monitoring system that runs periodic checks against a configurable markdown checklist, dispatches alerts through multiple channels (terminal notifications, voice, email), and maintains a full event log in a SQLite-backed blackboard.

Built with [Bun](https://bun.sh) and designed to run as a macOS launchd agent for hands-free monitoring.

## Quick Start

```bash
# Install dependencies
bun install

# Run checks once
bun src/cli.ts check

# Install as launchd agent (runs every 60 minutes)
bun src/cli.ts schedule install

# View dashboard
bun src/cli.ts observe --summary
```

## Architecture

```
ivy-heartbeat
├── src/
│   ├── cli.ts                 # Commander.js entry point
│   ├── blackboard.ts          # Wraps ivy-blackboard with FTS5 + query repos
│   ├── fts.ts                 # FTS5 virtual table setup + triggers
│   │
│   ├── commands/              # CLI commands
│   │   ├── agent.ts           # register / heartbeat / deregister / list
│   │   ├── check.ts           # Run checklist evaluation pipeline
│   │   ├── observe.ts         # Query events + heartbeats + dashboard
│   │   ├── schedule.ts        # launchd install / uninstall / status
│   │   ├── search.ts          # FTS5 full-text search
│   │   ├── export.ts          # Daily log export
│   │   └── serve.ts           # Web dashboard server
│   │
│   ├── check/                 # Check pipeline
│   │   ├── runner.ts          # Orchestrates: parse → due → guard → evaluate → alert
│   │   ├── evaluators.ts      # Evaluator registry (calendar, email, custom)
│   │   ├── due.ts             # Per-item due calculation from event history
│   │   ├── guard.ts           # Cost guard: skip when nothing due
│   │   └── types.ts           # CheckResult, CheckSummary, CheckOptions
│   │
│   ├── evaluators/            # Real evaluator implementations
│   │   ├── calendar.ts        # macOS Calendar via ical CLI, conflict detection
│   │   └── email.ts           # IMAP unread count, threshold alerting
│   │
│   ├── alert/                 # Alert delivery
│   │   ├── dispatcher.ts      # Routes to channel handlers
│   │   ├── terminal.ts        # macOS osascript notification
│   │   ├── voice.ts           # POST to PAI voice server (3s timeout)
│   │   ├── email.ts           # Stub (MVP)
│   │   ├── hours.ts           # Active hours check (08:00–22:00)
│   │   └── types.ts           # DispatchResult, ActiveHoursConfig
│   │
│   ├── parser/                # Checklist parser
│   │   ├── heartbeat-parser.ts # Markdown + YAML → ChecklistItem[]
│   │   └── types.ts           # Zod schemas for checklist items
│   │
│   ├── credential/            # Credential audit
│   │   ├── audit.ts           # logCredentialAccess / logCredentialDenied
│   │   ├── scope.ts           # Per-skill scope config
│   │   └── types.ts           # CredentialScopeConfig
│   │
│   ├── hooks/                 # Claude Code hooks
│   │   ├── post-session.ts    # Transcript analysis → blackboard events
│   │   ├── transcript.ts      # JSONL parser + session summary
│   │   └── extractor.ts       # Fact/pattern extraction
│   │
│   ├── export/                # Export utilities
│   │   └── daily-log.ts       # Markdown daily log from events
│   │
│   ├── observe/               # Observe utilities
│   │   └── summary.ts         # Aggregate dashboard summary
│   │
│   ├── serve/                 # Web dashboard
│   │   ├── server.ts          # Bun HTTP server + API routes
│   │   └── dashboard.ts       # Self-contained HTML template
│   │
│   ├── schedule/              # macOS scheduling
│   │   ├── plist.ts           # Plist XML generation
│   │   └── launchctl.ts       # launchctl load/unload/isLoaded
│   │
│   ├── scheduler/              # Autonomous dispatch pipeline
│   │   ├── scheduler.ts        # Work item dispatch: claim → execute → complete
│   │   ├── launcher.ts         # Claude Code launcher with Max OAuth auth
│   │   ├── specflow-runner.ts  # SpecFlow phase orchestration (specify→plan→tasks→implement→complete)
│   │   ├── specflow-types.ts   # SpecFlow metadata types
│   │   ├── review-agent.ts     # AI code review agent dispatch + result parsing
│   │   ├── rework.ts           # Rework cycle management (review→fix→re-review)
│   │   ├── pr-merge.ts         # Post-review PR merge automation
│   │   ├── merge-fix.ts        # Merge conflict resolution agent
│   │   ├── pr-comments.ts      # GitHub PR comment fetching for rework feedback
│   │   ├── worktree.ts         # Git worktree lifecycle management
│   │   └── types.ts            # Scheduler types
│   │
│   └── repositories/          # Query repositories
│       ├── events.ts          # getRecent, getSince, getByType, search
│       └── heartbeats.ts      # getLatest, getRecent, getBySession
│
└── test/                      # 443 tests across 29 files
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `check` | Run heartbeat checks from `~/.pai/IVY_HEARTBEAT.md` |
| `check --dry-run` | Show what would run without evaluating |
| `check --force` | Bypass cost guard, evaluate all due items |
| `observe` | Query recent events |
| `observe --summary` | Aggregate dashboard with stats |
| `observe --since <iso>` | Events since timestamp |
| `observe --agent <id>` | Filter by agent |
| `observe --credential` | Credential access/denial events |
| `observe --heartbeats` | Recent heartbeats |
| `search <query>` | FTS5 full-text search across events |
| `export --date YYYY-MM-DD` | Markdown daily log |
| `schedule install` | Install launchd agent |
| `schedule uninstall` | Remove launchd agent |
| `schedule status` | Show schedule status |
| `serve` | Web dashboard at localhost:7878 |
| `agent register` | Register a new agent session |
| `agent list` | Show active agents |
| `dispatch` | Dispatch pending work items to Claude Code agents |
| `dispatch --timeout <min>` | Per-item timeout (default: 10 min) |
| `dispatch --max <n>` | Max items to dispatch per run |
| `work list` | List work items with status |
| `work show <id>` | Show work item details |

Global flags: `--json`, `--db <path>`

## Checklist Format

The checklist lives at `~/.pai/IVY_HEARTBEAT.md`:

```markdown
# Ivy Heartbeat Checklist

## Calendar Conflicts
```yaml
type: calendar
severity: high
channels: [terminal, voice]
enabled: true
description: Check for scheduling conflicts
lookahead_hours: 24
interval_minutes: 120
```​

## Email Backlog
```yaml
type: email
severity: medium
channels: [terminal]
enabled: true
description: Check unread email count
max_unread: 10
interval_minutes: 180
```​
```

**Check types:** `calendar`, `email`, `custom`
**Severity:** `low`, `medium`, `high`, `critical`
**Channels:** `terminal`, `voice`, `email`

## Check Pipeline

```
Parse checklist → Filter enabled → Check due → Cost guard → Evaluate → Alert → Record
```

1. **Parse** — `~/.pai/IVY_HEARTBEAT.md` split by `##` headings, YAML validated with Zod
2. **Due check** — Query last run time from blackboard events, compare to `interval_minutes`
3. **Cost guard** — Skip entirely if nothing is due (bypass with `--force`)
4. **Evaluate** — Run type-specific evaluator (calendar/email/custom)
5. **Alert** — Dispatch to configured channels if status is `alert` or `error`
6. **Record** — Write results + dispatch events to blackboard

## Alert Channels

| Channel | Implementation | Notes |
|---------|----------------|-------|
| `terminal` | macOS osascript notification | Always available |
| `voice` | POST to localhost:8888/notify | PAI voice server, 3s timeout |
| `email` | Stub | Returns false (MVP) |

Alerts respect active hours (08:00–22:00 default). Outside this window, notifications are suppressed but events are still recorded.

## Web Dashboard

```bash
bun src/cli.ts serve --port 7878
```

Serves a self-contained HTML dashboard at `http://localhost:7878` with:
- Summary stats (events, agents, last heartbeat)
- Recent checks with status
- Event stream table
- Heartbeat timeline
- FTS5 search interface

API endpoints: `/api/events`, `/api/heartbeats`, `/api/summary`, `/api/search?q=`

## Autonomous Dispatch Pipeline

The scheduler dispatches work items from the blackboard to Claude Code agents:

```
Claim work item → Create worktree → Launch agent → Post-agent git ops → Code review → Merge/Rework
```

**Work item types:**
- **GitHub issues** — Auto-creates branch, worktree, PR, and code review
- **SpecFlow features** — Orchestrates specify → plan → tasks → implement → complete phases with quality gates
- **Code reviews** — AI review agent evaluates PRs against specs, approves or requests changes
- **Rework** — Addresses review feedback, pushes fixes, triggers re-review (max 2 cycles)
- **PR merge** — Merges approved PRs after successful review
- **Merge-fix** — Resolves merge conflicts when PRs can't cleanly merge

**SpecFlow integration:**
- Phases `specify`, `plan`, `tasks` route through Max OAuth launcher (no API credits)
- `implement` phase uses Claude Code with full MCP access in an isolated worktree
- `complete` phase creates PR and triggers the review pipeline
- Quality gates evaluate plan/spec quality with model-based rubric grading (80% threshold)

## Dependencies

- **[ivy-blackboard](https://github.com/jcfischer/ivy-blackboard)** — SQLite multi-agent coordination (agents, events, heartbeats)
- **[Bun](https://bun.sh)** — Runtime, test runner, HTTP server, SQLite
- **[Commander.js](https://github.com/tj/commander.js)** — CLI framework
- **[Zod](https://zod.dev)** — Schema validation
- **[js-yaml](https://github.com/nodeca/js-yaml)** — YAML parsing

## Tests

```bash
bun test                    # Run all tests
bun test test/fts.test.ts   # Run specific test file
```

## Configuration

The checklist lives at `~/.pai/IVY_HEARTBEAT.md` by default. Override with the `--checklist` flag or set a custom path.

Environment variables:
- `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS`, `IMAP_PORT` — for the email evaluator
- `CONTENT_FILTER_PATH` — path to an optional content filter CLI (for GitHub issue body filtering)
- `ICAL_CLI_PATH` — path to calendar CLI (default: `~/.claude/skills/Calendar/ical`)
- `SPECFLOW_BIN` — path to specflow binary (default: `~/bin/specflow`)
- `IVY_WORKTREE_DIR` — base directory for git worktrees (default: `~/.pai/worktrees`)
- `IVY_LOG_DIR` — directory for dispatch agent logs (default: `~/.pai/blackboard/logs`)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on how to contribute.

## Security

See [SECURITY.md](SECURITY.md) for our security policy and how to report vulnerabilities.

## License

[MIT](LICENSE) - Copyright (c) 2025-2026 Jens-Christian Fischer
