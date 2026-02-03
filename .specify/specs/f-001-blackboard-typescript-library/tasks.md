# F-001: Tasks

## Tasks

### T-1.1: Project Setup
- Run `bun init` in project root
- Add Zod dependency: `bun add zod`
- Configure tsconfig.json with strict mode
- Create directory structure: `src/`, `src/repositories/`, `src/utils/`, `test/`
- Add `.gitignore` entries for node_modules, *.db

### T-1.2: Define Types and Schemas
- File: `src/types.ts`
- Define all TypeScript interfaces: Agent, Project, WorkItem, Heartbeat, BlackboardEvent
- Define Zod schemas for runtime validation
- Define input types for create/update operations (Omit<> patterns)
- Export all types

### T-1.3: Implement Schema and Migrations
- File: `src/schema.ts`
- SQL string for base schema (all 5 tables + indexes + schema_version)
- Migration array with version-indexed functions
- `initSchema()` function: create tables if not exist
- `runMigrations()` function: check version, apply pending
- `getCurrentVersion()` helper

### T-1.4: Implement Path Resolution
- File: `src/utils/path.ts`
- `resolvePath(dbPath?: string)`: resolve ~ to $HOME, default to ~/.pai/blackboard/local.db
- `ensureDirectory(dbPath: string)`: create parent dirs via mkdirSync

### T-1.5: Implement JSON Helpers
- File: `src/utils/json.ts`
- `serializeMetadata(obj)`: object → JSON string (or null)
- `deserializeMetadata(str)`: JSON string → typed object (or null)
- Handle edge cases: null, undefined, invalid JSON

### T-1.6: Implement AgentRepository
- File: `src/repositories/agents.ts`
- register(), heartbeat(), deregister(), getActive(), getBySession(), cleanup()
- Prepared statements for each operation
- Map raw rows to Agent interface

### T-1.7: Implement ProjectRepository
- File: `src/repositories/projects.ts`
- register(), list(), get(), updateStatus()
- Prepared statements for each operation

### T-1.8: Implement WorkItemRepository
- File: `src/repositories/work-items.ts`
- create(), claim(), release(), complete(), list(), getByItem()
- list() supports optional filters: status, source, projectId
- claim/release use transactions

### T-1.9: Implement HeartbeatRepository
- File: `src/repositories/heartbeats.ts`
- record(), getLatest(), getRecent(), getSince()
- JSON metadata serialization for cost/model data

### T-1.10: Implement EventRepository
- File: `src/repositories/events.ts`
- append(), getRecent(), getSince(), getByType(), getByActor()
- Append-only (no update/delete operations)
- Support limit and since filters

### T-1.11: Implement Main Blackboard Class
- File: `src/blackboard.ts`
- Constructor: resolve path, create db, set pragmas, init schema, run migrations
- Expose all repositories as properties
- close() method
- Export as default

### T-1.12: Write Tests
- File: `test/blackboard.test.ts`
- Test schema initialization (tables exist)
- Test each repository's CRUD operations
- Test WAL mode active
- Test dual-location resolution
- Test JSON metadata round-trip
- Test foreign key enforcement
- Use temp files for test isolation

### T-1.13: Add CLI Entry Point
- File: `src/cli.ts`
- Minimal Commander.js setup for `blackboard` command
- Placeholder subcommands (agent, project, work, observe)
- Wire up to Blackboard class

## Verification

1. `bun test` passes all tests
2. Database creates at ~/.pai/blackboard/local.db
3. Database creates at custom path when specified
4. All 5 tables present with correct columns
5. WAL mode confirmed via PRAGMA check
6. Foreign keys enforced (insert with invalid FK fails)
7. JSON metadata survives round-trip
8. Schema version tracked and migrations applied
