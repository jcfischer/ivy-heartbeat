# F-006: Tasks

## Tasks

### T-6.1: Define Types
- File: `src/parser/types.ts`
- Export ChecklistItem interface and Zod schema
- Define CheckType, Severity, Channel enums

### T-6.2: Implement Parser
- File: `src/parser/heartbeat-parser.ts`
- `parseHeartbeatChecklist(path?)` — main entry point
- `parseContent(content: string)` — split and parse sections
- `parseSection(section: string)` — extract name + YAML + validate
- Add `js-yaml` dependency

### T-6.3: Write Tests
- File: `test/heartbeat-parser.test.ts`
- Valid 3-item file → 3 items returned
- Invalid item mixed with valid → valid items returned
- Missing file → empty array
- Empty file → empty array
- Default values applied for missing optional fields
- Use inline test content (no fixture files)

## Verification

1. Parses sample IVY_HEARTBEAT.md correctly
2. Returns typed ChecklistItem[] array
3. Handles missing file gracefully
4. Skips invalid items with console warning
5. All tests pass
