# F-006: Technical Plan

## Implementation

### Module Location
`src/parser/heartbeat-parser.ts`

### Interfaces
```typescript
import { z } from 'zod';

const CheckTypeSchema = z.enum(['calendar', 'email', 'custom']);
const SeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
const ChannelSchema = z.enum(['voice', 'terminal', 'email']);

const ChecklistItemSchema = z.object({
  name: z.string(),
  type: CheckTypeSchema,
  severity: SeveritySchema.default('medium'),
  channels: z.array(ChannelSchema).default(['terminal']),
  enabled: z.boolean().default(true),
  description: z.string(),
  config: z.record(z.unknown()).default({}),
});

type ChecklistItem = z.infer<typeof ChecklistItemSchema>;
```

### Parsing Strategy
1. Read file as UTF-8 string
2. Split by `## ` to find item boundaries
3. For each section after split:
   a. Extract heading text as `name`
   b. Find YAML block between ` ```yaml ` and ` ``` ` markers
   c. Parse YAML using simple key-value parser (no external YAML lib)
   d. Validate with Zod schema
   e. Collect valid items, warn on invalid

### YAML Parsing
Use a lightweight approach — the YAML blocks are flat key-value pairs with optional arrays. Either:
- Use `js-yaml` (add dependency)
- Or write a minimal parser for the flat structure

Decision: Use `js-yaml` — it's small, well-tested, and handles edge cases.

### Integration
```typescript
export async function parseHeartbeatChecklist(
  path?: string
): Promise<ChecklistItem[]> {
  const resolvedPath = resolvePath(path ?? '~/.pai/IVY_HEARTBEAT.md');
  if (!existsSync(resolvedPath)) return [];
  const content = readFileSync(resolvedPath, 'utf-8');
  return parseContent(content);
}
```

## Testing Strategy
- Valid file with 3 items → returns 3 ChecklistItem objects
- File with 1 invalid item among 3 → returns 2 valid items
- Missing file → returns empty array
- Empty file → returns empty array
- Items with missing optional fields → defaults applied
- Items with unknown type → skipped with warning
