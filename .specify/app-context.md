# App Context: Ivy Heartbeat

## Problem Statement

PAI agents are session-scoped and reactive — they only work when the user explicitly starts a Claude Code session. There is no proactive behavior, no persistent memory across sessions, no visibility into what agents did, and no awareness of external events (email, calendar). OpenClaw proved that "feels alive" = timers + context + channels, not cognitive architecture. Ivy needs proactive temporal behavior while maintaining PAI's security posture.

## Users & Stakeholders

- **Primary user:** PAI operator (single user, technical, runs Claude Code daily)
- **Technical level:** Developer comfortable with CLI, TypeScript, SQLite
- **Stakeholders:** PAI community (pai-collab), Daniel Miessler (PAI maintainer)

## Current State

- **PAI v2.5** with 50 skills, 27 hooks, CLI-first architecture
- **Local blackboard architecture** proposed in pai-collab issue #78 (SQLite at `~/.pai/blackboard/local.db`)
- **Blackboard schema:** `agents`, `projects`, `work_items`, `heartbeats`, `events` tables
- **Blackboard CLI:** `blackboard agent|project|work|observe|serve` commands
- **Existing infrastructure:** Voice server (ElevenLabs), Sentinel skill, launchd support, ACR embeddings
- **No existing:** Proactive heartbeat, daily memory logs, observability dashboard, external integrations

## Constraints & Requirements

### Hard Constraints (from council debate + #78 review)
- **No persistent daemon** — launchd fire-and-forget only
- **No token quota in blackboard** — stays in PAI runtime
- **SQLite WAL mode** for all concurrent access
- **Content filtering** on all external inputs (from pai-content-filter)
- **Awareness model, not assignment model** — agents decide what matters
- **CLI-first** — web dashboard is secondary
- **Cost under $0.01/day** for heartbeat at 1hr cadence

### Stack
- TypeScript + Bun
- SQLite via better-sqlite3 or bun:sqlite
- Commander.js for CLI
- Zod for validation
- Chart.js for dashboard charts (if needed)

## User Experience

- **Heartbeat:** User configures `IVY_HEARTBEAT.md`, launchd fires hourly, alerts via voice/terminal
- **Memory:** Post-session hook extracts facts automatically, user queries via `blackboard observe`
- **Observability:** `blackboard observe --heartbeats` for CLI, `blackboard serve` for web dashboard
- **Integrations:** Email/calendar data appears as work items in blackboard, visible to all agents

## Edge Cases & Error Handling

- Heartbeat runs when no checklist items changed → cost guard skips with event logged
- Multiple agents writing to blackboard simultaneously → SQLite WAL handles this
- Stale agent detection → PID check + timestamp, no daemon needed
- External data contains prompt injection → pai-content-filter blocks at adapter boundary
- Session crashes before post-session hook → partial data acceptable, next session catches up

## Success Criteria

- Ivy proactively alerts on meaningful events (calendar conflicts, email from important senders)
- User can ask "what happened while I was away?" and get a complete answer
- Cost is predictable and visible
- No security regressions (no persistent daemons, no unsandboxed external content)
- All data flows through blackboard — single source of truth

## Scope

### In Scope (4 Phases)
1. **Phase 1:** Proactive heartbeat via Sentinel + launchd + blackboard
2. **Phase 2:** Enhanced memory — post-session hooks, fact extraction, FTS5 search
3. **Phase 3:** Observability — CLI dashboard, web dashboard, credential audit
4. **Phase 4:** Read-only email/calendar integrations (conditional on Phase 1-3)

### Explicitly Out of Scope
- Token quota tracking (stays in PAI runtime)
- Skill marketplace
- Bidirectional messaging channels (Telegram, Discord, Slack)
- Agent-to-agent communication protocol
- Multi-operator coordination (that's pai-collab's job)
- Persistent gateway daemon
