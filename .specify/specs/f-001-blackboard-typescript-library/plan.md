# F-001: Technical Plan

## Implementation

### Project Setup
- Initialize Bun project with `bun init`
- Add Zod dependency
- Configure TypeScript strict mode
- Create `src/` directory structure

### Module Architecture
```
src/
  blackboard.ts          # Main Blackboard class (entry point)
  schema.ts              # SQL schema definitions and migrations
  types.ts               # TypeScript interfaces and Zod schemas
  repositories/
    agents.ts            # AgentRepository
    projects.ts          # ProjectRepository
    work-items.ts        # WorkItemRepository
    heartbeats.ts        # HeartbeatRepository
    events.ts            # EventRepository
  utils/
    path.ts              # Dual-location path resolution
    json.ts              # JSON metadata serialization helpers
```

### Core Interfaces

```typescript
// types.ts
import { z } from 'zod';

export const AgentStatusSchema = z.enum(['active', 'idle', 'completed', 'failed']);
export const ProjectStatusSchema = z.enum(['active', 'paused', 'completed']);
export const WorkItemSourceSchema = z.enum(['github', 'local', 'operator', 'email', 'calendar']);
export const WorkItemStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'blocked']);

export interface Agent { /* FR-2 */ }
export interface Project { /* FR-3 */ }
export interface WorkItem { /* FR-4 */ }
export interface Heartbeat { /* FR-5 */ }
export interface BlackboardEvent { /* FR-6 */ }
```

### Main Class

```typescript
// blackboard.ts
import { Database } from 'bun:sqlite';

export class Blackboard {
  readonly db: Database;
  readonly agents: AgentRepository;
  readonly projects: ProjectRepository;
  readonly workItems: WorkItemRepository;
  readonly heartbeats: HeartbeatRepository;
  readonly events: EventRepository;

  constructor(dbPath?: string) {
    const resolvedPath = resolvePath(dbPath);
    ensureDirectory(resolvedPath);
    this.db = new Database(resolvedPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.initSchema();
    this.runMigrations();
    // Initialize repositories
  }

  close(): void { this.db.close(); }
}
```

### Database Access Pattern
- Use `bun:sqlite` directly (no ORM)
- Prepared statements for all queries (`.prepare()`)
- Transactions via `db.transaction()` for multi-step ops
- Map raw rows to typed interfaces in repository layer

### Path Resolution
```typescript
function resolvePath(dbPath?: string): string {
  if (dbPath) return dbPath.replace(/^~/, process.env.HOME || '');
  const home = process.env.HOME || '';
  return `${home}/.pai/blackboard/local.db`;
}
```

### Migration Strategy
- `schema_version` table with single row
- Array of migration functions indexed by version
- On open: check version → apply pending migrations in order
- Version 1: Base schema (all 5 tables + indexes)

## Testing Strategy

- Unit tests for each repository (CRUD operations)
- Integration test for schema init + migration
- Test dual-location resolution
- Test concurrent access (WAL mode)
- Test JSON metadata round-trip
- Use temporary database files for test isolation
