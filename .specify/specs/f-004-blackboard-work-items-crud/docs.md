# F-004: Blackboard Work Items — Documentation

## Status: FULLY DELEGATED TO ivy-blackboard

All work item operations are handled by ivy-blackboard. ivy-heartbeat does not provide work item commands.

### Usage

Use ivy-blackboard's CLI directly:
```bash
blackboard work create --title "Review PR #42" --source github --priority P1
blackboard work claim --item <id> --session <session-id>
blackboard work release --item <id>
blackboard work complete --item <id>
blackboard work list
```

### Programmatic access from ivy-heartbeat

Access work items via the raw database handle if needed:
```typescript
import { Blackboard } from 'ivy-heartbeat/src/blackboard';
const bb = new Blackboard();
// Use bb.db with ivy-blackboard's work item functions
```
