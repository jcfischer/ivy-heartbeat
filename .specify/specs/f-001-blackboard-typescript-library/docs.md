# F-001: Documentation

## Files Created
- `src/blackboard.ts` — Main Blackboard class, entry point
- `src/types.ts` — All TypeScript interfaces and Zod schemas
- `src/schema.ts` — SQL schema definitions and migrations
- `src/repositories/agents.ts` — AgentRepository CRUD
- `src/repositories/projects.ts` — ProjectRepository CRUD
- `src/repositories/work-items.ts` — WorkItemRepository CRUD
- `src/repositories/heartbeats.ts` — HeartbeatRepository CRUD
- `src/repositories/events.ts` — EventRepository CRUD
- `src/utils/path.ts` — Path resolution and directory creation
- `src/utils/json.ts` — JSON serialization helpers

## Usage

```typescript
import { Blackboard } from './src/blackboard';

// Open default blackboard (~/.pai/blackboard/local.db)
const bb = new Blackboard();

// Or custom path
const bb = new Blackboard('/path/to/custom.db');

// Register an agent
const agent = bb.agents.register({
  agentName: 'Sentinel',
  project: 'ivy-heartbeat',
  currentWork: 'Checking heartbeat'
});

// Append an event
const event = bb.events.append({
  eventType: 'heartbeat_check',
  actorId: agent.sessionId,
  summary: 'Checked 5 items, 1 alert triggered',
  metadata: { cost: 0.0012, alerts: 1 }
});

// Query events
const recent = bb.events.getRecent(10);
const alerts = bb.events.getByType('heartbeat_alert');

// Clean up
bb.close();
```

## API Reference

See `src/types.ts` for all interface definitions.
See `src/blackboard.ts` for the main class API.
