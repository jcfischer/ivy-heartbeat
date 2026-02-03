# F-006: Documentation

## Files Created
- `src/parser/types.ts` — ChecklistItem interface, Zod schemas for CheckType, Severity, Channel
- `src/parser/heartbeat-parser.ts` — `parseHeartbeatChecklist()` and `parseContent()` functions

## Usage

```typescript
import { parseHeartbeatChecklist } from './src/parser/heartbeat-parser';

// Parse default location (~/.pai/IVY_HEARTBEAT.md)
const items = parseHeartbeatChecklist();

// Parse custom path
const items = parseHeartbeatChecklist('/path/to/checklist.md');

// Each item is typed:
for (const item of items) {
  console.log(item.name);        // "Calendar Conflicts"
  console.log(item.type);        // "calendar"
  console.log(item.severity);    // "medium"
  console.log(item.channels);    // ["voice", "terminal"]
  console.log(item.enabled);     // true
  console.log(item.description); // "Check for overlapping meetings..."
  console.log(item.config);      // {} or { senders: [...] } or { command: "..." }
}
```

## Dependencies Added
- `js-yaml` — YAML parsing for checklist item configuration blocks
- `@types/js-yaml` — TypeScript definitions (dev dependency)
