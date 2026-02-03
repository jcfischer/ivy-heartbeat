# F-001: Blackboard TypeScript Library

## Overview

Core TypeScript library providing SQLite-backed storage for the PAI Local Agent Blackboard. The blackboard is the central nervous system for all proactive Ivy behavior — a single source of truth for agent activity, work items, events, and heartbeats. Uses SQLite WAL mode for concurrent access and supports dual-location resolution (operator-wide at `~/.pai/blackboard/local.db` and project-specific at `.blackboard/local.db`).

## User Scenarios

### S-1: Initialize Blackboard
**Given** no blackboard database exists at `~/.pai/blackboard/local.db`
**When** the library is instantiated with no explicit path
**Then** it creates the directory and database with all tables and indexes

### S-2: Open Existing Blackboard
**Given** a blackboard database already exists
**When** the library is instantiated
**Then** it opens the existing database in WAL mode without data loss

### S-3: Project-Specific Blackboard
**Given** the caller passes a path to `.blackboard/local.db`
**When** the library is instantiated with that path
**Then** it creates/opens that project-specific database

### S-4: Concurrent Access
**Given** two processes open the same blackboard database
**When** both write simultaneously
**Then** WAL mode handles concurrent access without corruption

### S-5: Schema Migration
**Given** a blackboard database exists with an older schema version
**When** the library is instantiated
**Then** it detects the version mismatch and applies migrations incrementally

## Functional Requirements

### FR-1: Database Initialization
- Create `~/.pai/blackboard/` directory if it doesn't exist
- Initialize SQLite database in WAL mode (`PRAGMA journal_mode=WAL`)
- Create all tables: `agents`, `projects`, `work_items`, `heartbeats`, `events`
- Create all indexes on timestamp, type, actor, status, source columns
- Create `schema_version` table for migration tracking
- Set initial schema version to 1

### FR-2: Typed CRUD — Agents Table
```typescript
interface Agent {
  id: number;
  sessionId: string;    // unique
  agentName: string;
  pid: number | null;
  parentId: string | null;
  project: string | null;
  currentWork: string | null;
  status: 'active' | 'idle' | 'completed' | 'failed';
  startedAt: Date;
  lastSeenAt: Date;
}
```
Operations:
- `agents.register(opts)` — Insert new agent row
- `agents.heartbeat(sessionId)` — Update `last_seen_at`
- `agents.deregister(sessionId)` — Update status to 'completed'
- `agents.getActive()` — List all active agents
- `agents.getBySession(sessionId)` — Find by session_id
- `agents.cleanup(stalePidCheck: boolean)` — Remove stale agents

### FR-3: Typed CRUD — Projects Table
```typescript
interface Project {
  id: number;
  projectId: string;   // unique
  name: string;
  description: string | null;
  status: 'active' | 'paused' | 'completed';
  createdAt: Date;
}
```
Operations:
- `projects.register(opts)` — Insert new project
- `projects.list()` — List all projects
- `projects.get(projectId)` — Find by project_id
- `projects.updateStatus(projectId, status)` — Change status

### FR-4: Typed CRUD — Work Items Table
```typescript
interface WorkItem {
  id: number;
  itemId: string;      // unique
  projectId: string | null;
  title: string;
  description: string | null;
  source: 'github' | 'local' | 'operator' | 'email' | 'calendar';
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  priority: number;
  claimedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown> | null;
}
```
Operations:
- `workItems.create(opts)` — Insert new work item
- `workItems.claim(itemId, sessionId)` — Claim a work item
- `workItems.release(itemId)` — Release a claimed item
- `workItems.complete(itemId)` — Mark as completed
- `workItems.list(filters?)` — List with optional status/source/project filters
- `workItems.getByItem(itemId)` — Find by item_id

### FR-5: Typed CRUD — Heartbeats Table
```typescript
interface Heartbeat {
  id: number;
  sessionId: string;
  timestamp: Date;
  progress: string | null;
  workItemId: string | null;
  metadata: Record<string, unknown> | null;
}
```
Operations:
- `heartbeats.record(opts)` — Insert heartbeat row
- `heartbeats.getLatest()` — Get most recent heartbeat
- `heartbeats.getRecent(limit)` — Get N most recent
- `heartbeats.getSince(since: Date)` — Get all since timestamp

### FR-6: Typed CRUD — Events Table
```typescript
interface BlackboardEvent {
  id: number;
  eventType: string;
  actorId: string | null;
  targetId: string | null;
  summary: string;
  metadata: Record<string, unknown> | null;
  timestamp: Date;
}
```
Operations:
- `events.append(opts)` — Insert event (append-only)
- `events.getRecent(limit)` — Get N most recent events
- `events.getSince(since: Date)` — Get all since timestamp
- `events.getByType(eventType, opts?)` — Filter by event_type
- `events.getByActor(actorId, opts?)` — Filter by actor

### FR-7: Dual-Location Resolution
- Default path: `~/.pai/blackboard/local.db`
- Alternative: Accept explicit path for project-specific blackboard
- Resolve `~` to `$HOME` on all platforms

### FR-8: JSON Metadata Handling
- `metadata` columns store JSON strings in SQLite
- Library serializes objects to JSON on write
- Library deserializes JSON to typed objects on read
- Handle `null` metadata gracefully

### FR-9: Schema Migration
- `schema_version` table tracks current version
- Migrations run incrementally (v1 → v2 → v3)
- Each migration is idempotent (safe to re-run)
- Library checks version on instantiation and auto-migrates

## Non-Functional Requirements

### NFR-1: Performance
- Database open in under 50ms
- Single CRUD operation in under 10ms
- WAL mode for concurrent readers

### NFR-2: Data Safety
- WAL mode prevents corruption on concurrent access
- Foreign keys enforced (`PRAGMA foreign_keys = ON`)
- Transactions for multi-step operations

### NFR-3: Zero External Dependencies (beyond Bun)
- Use `bun:sqlite` (built-in)
- Zod for runtime validation
- No ORM (direct SQL)

## Success Criteria

1. Database initializes with all 5 tables and indexes
2. WAL mode active on all connections
3. All CRUD operations return typed objects (not raw rows)
4. Dual-location resolution works (`~/.pai/` and custom path)
5. JSON metadata serializes/deserializes correctly
6. Schema migration detects version and applies updates
7. Foreign key constraints enforced
8. Tests pass for all CRUD operations
