# F-006: IVY_HEARTBEAT.md Parser

## Overview

Parse heartbeat checklist configuration from `~/.pai/IVY_HEARTBEAT.md`. The file defines what the Sentinel should check on each heartbeat run — checklist items with check type, severity, notification channels, and enabled/disabled state. The parser converts this Markdown+YAML configuration into typed TypeScript objects for the Sentinel heartbeat command.

## User Scenarios

### S-1: Parse Valid Checklist
**Given** `~/.pai/IVY_HEARTBEAT.md` contains properly formatted checklist items
**When** the parser reads the file
**Then** it returns an array of typed ChecklistItem objects

### S-2: Handle Missing File
**Given** `~/.pai/IVY_HEARTBEAT.md` does not exist
**When** the parser attempts to read it
**Then** it returns an empty array (no items to check)

### S-3: Handle Disabled Items
**Given** a checklist item has `enabled: false`
**When** the parser reads the file
**Then** the item is included with `enabled: false` (caller decides whether to skip)

### S-4: Handle Malformed Items
**Given** a checklist item has invalid or missing required fields
**When** the parser reads the file
**Then** that item is skipped with a warning, other valid items are returned

### S-5: Custom Checklist Path
**Given** the caller provides a custom path
**When** the parser reads from that path
**Then** it parses the file at the custom location instead of the default

## Functional Requirements

### FR-1: File Format
The file uses Markdown headings with YAML frontmatter per item:

```markdown
# Ivy Heartbeat Checklist

## Calendar Conflicts
```yaml
type: calendar
severity: medium
channels: [voice, terminal]
enabled: true
description: Check for overlapping meetings in the next 24 hours
```

## Important Emails
```yaml
type: email
severity: low
channels: [terminal]
enabled: true
description: Check for emails from VIP senders
senders:
  - boss@company.com
  - client@important.org
```

## Custom Check
```yaml
type: custom
severity: high
channels: [voice, terminal, email]
enabled: true
description: Run custom script to check system health
command: ~/.pai/checks/health.sh
```
```

### FR-2: ChecklistItem Type
```typescript
interface ChecklistItem {
  name: string;           // From ## heading
  type: 'calendar' | 'email' | 'custom';
  severity: 'low' | 'medium' | 'high' | 'critical';
  channels: ('voice' | 'terminal' | 'email')[];
  enabled: boolean;
  description: string;
  config: Record<string, unknown>;  // type-specific config (senders, command, etc.)
}
```

### FR-3: Parsing Rules
- Top-level `# heading` is the file title (ignored)
- Each `## heading` starts a new checklist item
- YAML block after `## heading` contains item configuration
- `name` is derived from the `## heading` text
- `type`, `severity`, `channels`, `enabled`, `description` are required fields
- Any additional YAML fields go into `config` object

### FR-4: Validation
- Validate with Zod schemas
- Unknown `type` values: warn and skip item
- Missing required fields: warn and skip item
- Invalid `severity` values: default to 'medium'
- Missing `channels`: default to `['terminal']`
- Missing `enabled`: default to `true`

### FR-5: Default Path
- Default: `~/.pai/IVY_HEARTBEAT.md`
- Accept optional override path
- Resolve `~` to `$HOME`

## Success Criteria

1. Parses valid checklist file into typed ChecklistItem array
2. Returns empty array for missing file (not error)
3. Skips malformed items without crashing
4. Validates all fields with Zod
5. Handles all three check types: calendar, email, custom
6. Config object captures type-specific fields
7. Tests pass for valid, invalid, missing, and mixed input
