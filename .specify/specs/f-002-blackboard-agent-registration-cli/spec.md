# F-002: ivy-heartbeat CLI Framework

## Overview

CLI entry point for ivy-heartbeat using Commander.js. Provides `agent` subcommands for lifecycle management and `observe` subcommands for querying heartbeats and events. All operations delegate to the Blackboard class which in turn delegates to ivy-blackboard.

**Architecture change**: The original spec assumed ivy-heartbeat would own the agent CRUD. Now ivy-blackboard (upstream dependency) owns the core agent/event/work-item operations. ivy-heartbeat's CLI wraps the Blackboard class to provide a unified interface.

## User Scenarios

### S-1: Register Agent
**Given** a new agent process starts
**When** it runs `ivy-heartbeat agent register --name Sentinel --project ivy-heartbeat`
**Then** a new agent row is created via ivy-blackboard with UUID session and active status

### S-2: Heartbeat Update
**Given** a registered agent is running
**When** it runs `ivy-heartbeat agent heartbeat --session <id> --progress "Checked 5 items"`
**Then** the agent's last_seen_at is updated and a heartbeat row is inserted

### S-3: Deregister Agent
**Given** a registered agent is finishing
**When** it runs `ivy-heartbeat agent deregister --session <id>`
**Then** the agent's status is set to 'completed' and claimed work items are released

### S-4: List Active Agents
**Given** multiple agents are registered
**When** the operator runs `ivy-heartbeat agent list`
**Then** it shows active agents with name, PID, project, last seen in a formatted table

### S-5: Observe Events
**Given** events exist in the blackboard
**When** the operator runs `ivy-heartbeat observe --events --limit 10`
**Then** the 10 most recent events are shown in a formatted table

### S-6: Observe Heartbeats
**Given** heartbeats exist for registered agents
**When** the operator runs `ivy-heartbeat observe --heartbeats --session <id>`
**Then** heartbeats for that session are shown in a formatted table

## Functional Requirements

### FR-1: CLI Entry Point
- `ivy-heartbeat` — Commander.js program with global `--json` and `--db <path>` options
- Lazy database initialization (open on first command that needs it)
- Clean shutdown via process exit handler

### FR-2: Agent Register Command
- `ivy-heartbeat agent register --name <name> [--project <project>] [--work <desc>] [--parent <sessionId>]`
- Delegates to `Blackboard.registerAgent()`
- Returns session_id to stdout
- Supports `--json` output

### FR-3: Agent Heartbeat Command
- `ivy-heartbeat agent heartbeat --session <id> [--progress <text>]`
- Delegates to `Blackboard.sendHeartbeat()`
- Supports `--json` output

### FR-4: Agent Deregister Command
- `ivy-heartbeat agent deregister --session <id>`
- Delegates to `Blackboard.deregisterAgent()`
- Shows released work item count and session duration

### FR-5: Agent List Command
- `ivy-heartbeat agent list [--all] [--status <status>]`
- Uses `listAgents()` from ivy-blackboard directly
- Formatted table: SESSION, NAME, PROJECT, STATUS, LAST SEEN, PID
- `--all` includes completed/stale

### FR-6: Observe Command
- `ivy-heartbeat observe [--events] [--heartbeats] [--limit <n>] [--type <type>] [--session <id>]`
- `--events`: query via EventQueryRepository
- `--heartbeats`: query via HeartbeatQueryRepository
- `--type`: filter events by event_type
- `--session`: filter heartbeats by session_id
- Default limit: 20
- Supports `--json` output

### FR-7: Output Formatting
- Import `formatTable`, `formatJson`, `formatRelativeTime` from ivy-blackboard/src/output
- Consistent table formatting with aligned columns

## Dependencies
- F-001 (Blackboard TypeScript library — completed)
- ivy-blackboard (upstream dependency — agent.ts, output.ts)

## Success Criteria

1. All commands delegate to Blackboard class correctly
2. `--json` flag produces structured JSON output
3. Table output is readable with aligned columns
4. Agent register returns session_id to stdout
5. Observe shows heartbeats and events with proper formatting
6. CLI handles errors gracefully (unknown session, etc.)
