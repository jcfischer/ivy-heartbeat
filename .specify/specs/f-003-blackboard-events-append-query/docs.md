# F-003: Blackboard Events — Documentation

## Status: DELEGATED TO ivy-blackboard

Event operations are split between ivy-blackboard (owner) and ivy-heartbeat (consumer).

### ivy-heartbeat API

**`Blackboard.appendEvent(opts)`** — Append a heartbeat-specific event:
```typescript
bb.appendEvent({
  actorId: sessionId,
  targetId: sessionId,
  summary: 'Calendar conflict detected',
  metadata: { severity: 'high' },
});
```
Uses `heartbeat_received` event type (CHECK constraint workaround, issue #2).

**`EventQueryRepository`** — Read-only queries:
```typescript
bb.eventQueries.getRecent(20);
bb.eventQueries.getByType('heartbeat_received');
bb.eventQueries.getByActor(sessionId);
bb.eventQueries.getSince('2026-02-03T00:00:00Z');
```

### CLI
```bash
ivy-heartbeat observe --events --limit 10
ivy-heartbeat observe --events --type agent_registered
```

### Full event operations
Use `blackboard observe` CLI from ivy-blackboard for full event management.
