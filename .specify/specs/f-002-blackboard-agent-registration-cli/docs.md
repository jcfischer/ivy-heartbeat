# F-002: ivy-heartbeat CLI Framework — Documentation

## Overview

CLI entry point for ivy-heartbeat using Commander.js. Provides agent lifecycle commands and observe queries, all delegating to the Blackboard class (which wraps ivy-blackboard).

## Installation

```bash
bun link  # makes ivy-heartbeat available as CLI command
```

## Commands

### `ivy-heartbeat agent register`
Register a new agent session.

```bash
ivy-heartbeat agent register --name Sentinel --project ivy-heartbeat --work "Running checks"
# Output: <session-id>

ivy-heartbeat --json agent register --name Sentinel
# Output: JSON envelope with session_id, agent_name, pid, status, etc.
```

Options:
- `--name <name>` (required) — Agent display name
- `--project <project>` — Project context
- `--work <work>` — Current work description
- `--parent <sessionId>` — Parent session ID for delegates

### `ivy-heartbeat agent heartbeat`
Send a heartbeat for an active session.

```bash
ivy-heartbeat agent heartbeat --session <id> --progress "Checked 5 items"
```

Options:
- `--session <id>` (required) — Session ID
- `--progress <text>` — Progress note

### `ivy-heartbeat agent deregister`
Deregister an agent session.

```bash
ivy-heartbeat agent deregister --session <id>
# Output: agent name, released work items, session duration
```

### `ivy-heartbeat agent list`
List agent sessions.

```bash
ivy-heartbeat agent list          # active only
ivy-heartbeat agent list --all    # include completed/stale
ivy-heartbeat agent list --status completed
```

### `ivy-heartbeat observe`
Query events and heartbeats.

```bash
ivy-heartbeat observe --events --limit 10
ivy-heartbeat observe --events --type agent_registered
ivy-heartbeat observe --heartbeats --session <id>
ivy-heartbeat observe --heartbeats --limit 5
```

Default: shows events if neither `--events` nor `--heartbeats` is specified.

## Global Options

- `-j, --json` — Output as JSON envelope (`{ ok, ..., timestamp }`)
- `--db <path>` — Override database path

## Architecture

```
src/cli.ts              → Commander program, lazy Blackboard init
src/commands/agent.ts   → Agent lifecycle (register, heartbeat, deregister, list)
src/commands/observe.ts → Event and heartbeat queries
```

All commands delegate to `Blackboard` class methods or ivy-blackboard's `listAgents()`. Output formatting uses ivy-blackboard's `formatTable`, `formatJson`, `formatRelativeTime`.

## Pre-Verification Checklist

- [x] CLI compiles and runs
- [x] All 4 agent commands work (register, heartbeat, deregister, list)
- [x] Observe command works for events and heartbeats
- [x] JSON output mode works
- [x] Error handling for unknown sessions
- [x] 59 tests pass

## Smoke Test Results

```
$ ivy-heartbeat agent register --name TestAgent
eb79facd-10a8-4a0e-8959-9652c510c8bc

$ ivy-heartbeat agent heartbeat --session eb79facd... --progress "Checking items"
Heartbeat sent for eb79facd...
Progress: Checking items

$ ivy-heartbeat agent list
SESSION       NAME       PROJECT  STATUS  LAST SEEN  PID
──────────────────────────────────────────────────────────
eb79facd-10a  TestAgent  -        active  just now   33823

$ ivy-heartbeat observe --events
TIME      TYPE                ACTOR         SUMMARY
──────────────────────────────────────────────────────────
just now  heartbeat_received  eb79facd-10a  Heartbeat: Checking items
just now  agent_registered    eb79facd-10a  Agent "TestAgent" registered...

$ ivy-heartbeat agent deregister --session eb79facd...
Deregistered TestAgent (eb79facd...)
Released 0 work item(s)
Duration: 1s
```
