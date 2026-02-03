# Ivy Evolution Roadmap: Blackboard-Integrated Specification

**Date:** 2026-02-03
**Source:** Council debate (OpenClaw insights) + Local blackboard architecture (issue #78)
**Status:** Specification — ready for implementation
**Authority:** PAI maintainers

---

## Architecture Decision: Blackboard as Central Data Bus

### The Problem with Scattered Flat Files

Prior to this specification, Ivy's proactive features would have relied on scattered flat files:
- `IVY_HEARTBEAT.md` for checklist configuration
- Separate log files for heartbeat history
- Session transcripts in `.jsonl` files
- Daily logs in `MEMORY/DAILY/` directories
- FTS5 index in a separate SQLite database
- Email/calendar data in yet another location

**This creates fragmentation:**
- No single source of truth for "what happened while I was away?"
- Difficult to correlate events across subsystems
- Multiple indexing strategies competing for resources
- Complex migration paths when adding new data sources

### The Blackboard Solution

The **Local Agent Blackboard** at `~/.pai/blackboard/local.db` becomes the **central nervous system** for all proactive Ivy behavior. It provides:

1. **Single source of truth** — All agent activity, work items, events, and heartbeats in one place
2. **Native queryability** — SQLite with WAL mode for concurrent reads
3. **Event sourcing** — Append-only events table captures everything
4. **Built-in search** — FTS5 on events.summary + heartbeats.progress for free
5. **Standardized schema** — Consistent data model across all phases
6. **Operator-wide scope** — `~/.pai/blackboard/local.db` shared across all projects
7. **Project-specific scope** — `.blackboard/local.db` per-project when needed

### How the 4 Phases Map to Blackboard Primitives

| Phase | Council Vision | Blackboard Implementation |
|-------|---------------|--------------------------|
| **Phase 1: Heartbeat** | Sentinel checks `IVY_HEARTBEAT.md`, logs results, sends alerts | Heartbeat runs → writes `heartbeats` row → appends event → queries for "what changed?" |
| **Phase 2: Memory** | Daily logs + FTS5 keyword search + semantic retrieval | Daily logs ARE events table rows → FTS5 on `events.summary` → no separate index needed |
| **Phase 3: Observability** | Dashboard showing "what did Ivy do?" + cost tracking | `blackboard observe` queries events + heartbeats tables → `blackboard serve` is the dashboard |
| **Phase 4: Integrations** | Email/calendar data enters system | Work items with `source='email'` or `source='calendar'` → agents query work_items table |

**Key insight:** The blackboard doesn't replace the 4-phase plan — it provides the **infrastructure** that makes all 4 phases work without reinventing storage for each.

---

## Phase 1: Proactive Heartbeat — Immediate (Week 1)

### What Changes from Council Spec

**Council spec said:**
- Read `IVY_HEARTBEAT.md` for checklist
- Log results to `~/.claude/heartbeat.jsonl`
- Deliver alerts via voice/terminal/email

**Blackboard integration adds:**
- `IVY_HEARTBEAT.md` is still the **configuration** (defines WHAT to check)
- Results are written to the **blackboard** (WHERE they're stored)
- Heartbeat history is queryable via `blackboard observe --heartbeats`
- Cost tracking happens automatically (each heartbeat is an event with metadata)

### Blackboard Integration

#### Schema Usage

**Tables involved:**
```sql
-- Agent registration (Sentinel registers on first run)
INSERT INTO agents (
  session_id, agent_name, pid, project,
  current_work, status, started_at, last_seen_at
) VALUES (
  'hb-2026-02-03-14:30:00', 'Sentinel', $$, 'ivy-heartbeat',
  'Checking heartbeat checklist', 'active', NOW(), NOW()
);

-- Heartbeat result (after each check)
INSERT INTO heartbeats (
  session_id, timestamp, progress, work_item_id, metadata
) VALUES (
  'hb-2026-02-03-14:30:00', NOW(),
  'Checked 5 items, 1 alert triggered', NULL,
  '{"checklist_path": "~/.pai/IVY_HEARTBEAT.md", "model": "haiku", "cost": 0.0012, "alerts": 1}'
);

-- Event log (for queryability)
INSERT INTO events (
  event_type, actor_id, summary, metadata
) VALUES (
  'heartbeat_check', 'hb-2026-02-03-14:30:00',
  'Calendar conflict detected: meeting overlap at 3pm',
  '{"severity": "medium", "action_taken": "voice_alert_sent", "checklist_item": "calendar_conflicts"}'
);
```

**Event types introduced:**
- `heartbeat_check` — routine check completed
- `heartbeat_alert` — alert triggered and delivered
- `heartbeat_skipped` — check skipped due to cost guard or no changes

#### Workflow Integration

**Step 1: launchd triggers Sentinel**
```bash
# launchd plist fires every 1 hour (configurable)
claude --headless --skill Sentinel --args "heartbeat check"
```

**Step 2: Sentinel registers in blackboard**
```typescript
// Sentinel skill startup
await blackboard.agent.register({
  agentName: 'Sentinel',
  project: 'ivy-heartbeat',
  currentWork: 'Checking heartbeat checklist'
});
```

**Step 3: Sentinel reads IVY_HEARTBEAT.md**
```typescript
const checklist = await readFile('~/.pai/IVY_HEARTBEAT.md');
const items = parseChecklistItems(checklist); // YAML or Markdown parser
```

**Step 4: Sentinel evaluates each item**
```typescript
for (const item of items) {
  const result = await evaluateItem(item); // Could invoke other skills
  if (result.alert) {
    await blackboard.events.append({
      eventType: 'heartbeat_alert',
      actorId: sessionId,
      summary: result.message,
      metadata: { item: item.name, severity: result.severity }
    });
    await deliverAlert(result); // Voice/terminal/email
  }
}
```

**Step 5: Sentinel writes heartbeat summary**
```typescript
await blackboard.heartbeats.record({
  sessionId,
  progress: `Checked ${items.length} items, ${alerts.length} alerts`,
  metadata: {
    checklistPath: '~/.pai/IVY_HEARTBEAT.md',
    model: 'haiku',
    cost: estimatedCost,
    alerts: alerts.length
  }
});
```

**Step 6: Sentinel updates last_seen_at**
```typescript
await blackboard.agent.heartbeat(sessionId);
```

#### Cost Guard Implementation

**Before API call:**
```typescript
// Check if checklist changed since last check
const lastCheck = await blackboard.heartbeats.getLatest();
const checklistHash = await hashFile('~/.pai/IVY_HEARTBEAT.md');

if (lastCheck?.metadata?.checklistHash === checklistHash) {
  await blackboard.events.append({
    eventType: 'heartbeat_skipped',
    actorId: sessionId,
    summary: 'Checklist unchanged since last check',
    metadata: { reason: 'cost_guard', savedCost: 0.0012 }
  });
  return;
}
```

#### Query Interface

**"What did the last heartbeat find?"**
```bash
blackboard observe --heartbeats --limit 1
```

**"Show me all heartbeat alerts today"**
```bash
blackboard observe --events --type heartbeat_alert --since today
```

**"Heartbeat cost this week"**
```bash
blackboard observe --heartbeats --since "1 week ago" --sum-metadata cost
```

### Implementation Steps

1. **Extend blackboard schema** with `heartbeat_*` event types (see Schema Extensions section)
2. **Extend Sentinel skill** to accept `heartbeat check` command
3. **Add blackboard client** to Sentinel skill (TypeScript/Bun)
4. **Create launchd plist** with configurable interval (default 1h)
5. **Implement IVY_HEARTBEAT.md parser** (YAML or Markdown)
6. **Implement cost guard logic** (hash-based change detection)
7. **Integrate voice notification** (existing voice server)
8. **Add `blackboard observe --heartbeats`** command
9. **Write integration tests** (mock launchd, test event flow)

### Success Criteria

**From council + blackboard-specific:**

- [ ] Heartbeat runs reliably at configured interval via launchd
- [ ] Sentinel registers in blackboard on each run
- [ ] Checklist items are evaluated and results stored in events table
- [ ] Alerts delivered within 30 seconds of check completion
- [ ] Cost under $0.01/day for 1hr cadence (verified via blackboard query)
- [ ] No false positives (alerts only when something matters)
- [ ] `blackboard observe --heartbeats` shows complete history
- [ ] Cost guard skips checks when checklist unchanged (logged as event)
- [ ] No persistent daemon (launchd fire-and-forget)
- [ ] Active hours respected (08:00-23:59 from settings.json)

---

## Phase 2: Enhanced Memory — Weeks 2-3

### What Changes from Council Spec

**Council spec said:**
- Add `MEMORY/DAILY/YYYY-MM-DD.md` append-only logs
- Add FTS5 keyword index alongside ACR embeddings
- Session lifecycle hooks for post-session extraction

**Blackboard integration adds:**
- Daily logs **are** rows in the `events` table with `event_type='session_log'`
- FTS5 happens **on the events table** (no separate index)
- Hybrid search (semantic + keyword) queries **one source** (blackboard + ACR)
- Post-session hook writes to blackboard instead of flat files

### Blackboard Integration

#### Schema Usage

**Session lifecycle events:**
```sql
-- Session start
INSERT INTO events (event_type, actor_id, summary, metadata)
VALUES ('session_started', 'claude-2026-02-03-09:15:00',
        'User opened Claude Code in kai-improvement-roadmap',
        '{"project": "kai-improvement-roadmap", "cwd": "/Users/fischer/work/kai-improvement-roadmap"}');

-- Session activity (extracted by post-session hook)
INSERT INTO events (event_type, actor_id, summary, metadata)
VALUES ('session_activity', 'claude-2026-02-03-09:15:00',
        'Created specification for Ivy blackboard integration',
        '{"files_created": 1, "files_read": 3, "tools_used": ["Read", "Write"], "phase": "PLAN"}');

-- Facts extracted
INSERT INTO events (event_type, actor_id, summary, metadata)
VALUES ('fact_extracted', 'claude-2026-02-03-09:15:00',
        'Ivy heartbeat will use blackboard instead of flat files',
        '{"category": "architectural_decision", "confidence": "high"}');

-- Pattern detected
INSERT INTO events (event_type, actor_id, summary, metadata)
VALUES ('pattern_detected', 'claude-2026-02-03-09:15:00',
        'User frequently asks for council debates on architectural decisions',
        '{"pattern_type": "workflow_preference", "occurrences": 5}');

-- Session end
INSERT INTO events (event_type, actor_id, summary, metadata)
VALUES ('session_ended', 'claude-2026-02-03-09:15:00',
        'Session completed: 1 file written, 3 files read',
        '{"duration_minutes": 45, "isc_pass_rate": 1.0, "cost": 0.32}');
```

#### FTS5 Virtual Table

**Create FTS5 index on events:**
```sql
CREATE VIRTUAL TABLE events_fts USING fts5(
  summary,
  metadata,
  content='events',
  content_rowid='id'
);

-- Triggers to keep FTS5 in sync
CREATE TRIGGER events_fts_insert AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, summary, metadata)
  VALUES (new.id, new.summary, new.metadata);
END;

CREATE TRIGGER events_fts_delete AFTER DELETE ON events BEGIN
  DELETE FROM events_fts WHERE rowid = old.id;
END;
```

**Hybrid search example:**
```sql
-- Keyword search: "exact phrase I said last Tuesday"
SELECT e.* FROM events e
JOIN events_fts fts ON e.id = fts.rowid
WHERE events_fts MATCH '"exact phrase I said"'
  AND e.timestamp >= date('now', '-7 days')
  AND e.event_type IN ('session_activity', 'fact_extracted')
ORDER BY e.timestamp DESC;

-- Semantic search: "what did we discuss about architecture?"
-- (This still uses ACR embeddings, but results are enriched with blackboard events)
```

#### Post-Session Hook

**Hook location:** `~/.claude/hooks/post-session`

**Responsibilities:**
1. Read session transcript from Claude Code
2. Extract facts, patterns, insights using haiku
3. Write events to blackboard
4. Update ACR embeddings with extracted facts
5. Checkpoint session state

**Implementation sketch:**
```typescript
#!/usr/bin/env bun

import { Blackboard } from '~/work/DA/KAI/lib/blackboard';
import { extractFacts } from './extractors/fact-extractor';
import { detectPatterns } from './extractors/pattern-detector';
import { ACR } from '~/work/acr';

const sessionId = process.env.CLAUDE_SESSION_ID;
const transcript = await readTranscript(sessionId);

// Extract structured data
const facts = await extractFacts(transcript); // Uses haiku
const patterns = await detectPatterns(transcript); // Uses haiku
const summary = generateSummary(transcript);

// Write to blackboard
const bb = new Blackboard('~/.pai/blackboard/local.db');

await bb.events.append({
  eventType: 'session_activity',
  actorId: sessionId,
  summary: summary,
  metadata: {
    filesCreated: transcript.filesCreated.length,
    filesRead: transcript.filesRead.length,
    toolsUsed: transcript.tools,
    phase: transcript.phases
  }
});

for (const fact of facts) {
  await bb.events.append({
    eventType: 'fact_extracted',
    actorId: sessionId,
    summary: fact.text,
    metadata: { category: fact.category, confidence: fact.confidence }
  });
}

for (const pattern of patterns) {
  await bb.events.append({
    eventType: 'pattern_detected',
    actorId: sessionId,
    summary: pattern.description,
    metadata: { patternType: pattern.type, occurrences: pattern.count }
  });
}

// Also feed to ACR for semantic search
await ACR.index({ source: 'blackboard-events', data: facts });
```

#### "Daily Log" View

**The daily log is now a query, not a file:**
```bash
# Show everything that happened today
blackboard observe --events --since today --type "session_*,fact_extracted,pattern_detected"

# Or generate a Markdown file on demand
blackboard export --daily-log --date 2026-02-03 > MEMORY/DAILY/2026-02-03.md
```

**Generated format:**
```markdown
# Daily Log: 2026-02-03

## Sessions

### Session 1: 09:15-10:00 (kai-improvement-roadmap)
- **Summary:** Created specification for Ivy blackboard integration
- **Facts extracted:** 5
- **Patterns detected:** 1
- **Files:** 1 created, 3 read
- **Cost:** $0.32

### Session 2: 14:30-15:15 (PAI core)
...

## Facts Learned
- Ivy heartbeat will use blackboard instead of flat files
- Council debate model produces high-quality architectural specs
...

## Patterns Detected
- User frequently asks for council debates on architectural decisions (5 occurrences)
...
```

### Implementation Steps

1. **Extend blackboard schema** with `session_*`, `fact_extracted`, `pattern_detected` event types
2. **Add FTS5 virtual table** to blackboard schema (with triggers)
3. **Create post-session hook** (`~/.claude/hooks/post-session`)
4. **Implement fact extractor** (haiku-based, uses Claude API)
5. **Implement pattern detector** (haiku-based, tracks recurring sequences)
6. **Integrate with kai-launcher** to trigger post-session hook
7. **Add `blackboard export --daily-log`** command
8. **Add `blackboard observe --events --fts "search query"`** for keyword search
9. **Update ACR** to query blackboard events as an additional source
10. **Write integration tests** (mock sessions, verify event extraction)

### Success Criteria

**From council + blackboard-specific:**

- [ ] Post-session hook fires reliably after each session
- [ ] Facts extracted from transcripts and stored as events
- [ ] Patterns detected across multiple sessions
- [ ] FTS5 search returns exact phrases within 100ms
- [ ] Daily logs queryable via `blackboard observe --since <date>`
- [ ] Daily logs exportable as Markdown on demand
- [ ] Hybrid search (ACR semantic + blackboard keyword) works end-to-end
- [ ] No separate flat files created (blackboard is source of truth)
- [ ] Session cost tracked in events metadata
- [ ] User can query "exact phrase I said last Tuesday" successfully

---

## Phase 3: Observability & Hardening — Week 4

### What Changes from Council Spec

**Council spec said:**
- Heartbeat dashboard (CLI or web) showing last check, next check, why it ran
- Heartbeat transcript archival in `~/.claude/heartbeat.jsonl`
- Credential hardening (Keychain integration, per-skill scoping)

**Blackboard integration adds:**
- `blackboard serve` **is** the dashboard (web interface)
- `blackboard observe` **is** the CLI dashboard
- Heartbeat history is already in the blackboard (no separate archive)
- Credential audit log uses events table

### Blackboard Integration

#### `blackboard observe` CLI

**Command interface:**
```bash
# Show heartbeat summary
blackboard observe --heartbeats
# Output:
# Last check: 14:30:00 (5 minutes ago)
# Next check: 15:30:00 (in 55 minutes)
# Status: OK (0 alerts)
# Cost today: $0.05 (5 checks)

# Show recent events
blackboard observe --events --limit 10
# Output: Table with timestamp, event_type, actor, summary

# Show "what happened while I was away?"
blackboard observe --since "2026-02-02 18:00:00"
# Output: All events (sessions, heartbeats, facts, patterns) since timestamp

# Search events
blackboard observe --fts "calendar conflict"
# Output: All events matching keyword search

# Filter by agent
blackboard observe --agent Sentinel --since today
# Output: All Sentinel activity today

# Show cost breakdown
blackboard observe --heartbeats --since "1 week ago" --aggregate cost
# Output: Total cost, per-day breakdown, model usage
```

#### `blackboard serve` Web Dashboard

**URL:** `http://localhost:7878` (or configurable port)

**Features:**
1. **Real-time agent status** — All registered agents, their current work, last seen
2. **Heartbeat timeline** — Visual timeline of heartbeat checks and alerts
3. **Event stream** — Live feed of events as they're appended
4. **Cost tracking** — Charts showing daily/weekly cost trends
5. **Search interface** — FTS5 keyword search + filtering
6. **Session explorer** — Browse past sessions, view extracted facts

**Technology:** Simple Bun HTTP server serving static HTML + WebSocket for live updates

**Implementation sketch:**
```typescript
// blackboard-server.ts
import { serve } from 'bun';

const bb = new Blackboard('~/.pai/blackboard/local.db');

serve({
  port: 7878,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/api/heartbeats') {
      const heartbeats = await bb.heartbeats.getRecent(50);
      return Response.json(heartbeats);
    }

    if (url.pathname === '/api/events') {
      const events = await bb.events.getRecent(100);
      return Response.json(events);
    }

    if (url.pathname === '/api/agents') {
      const agents = await bb.agents.getActive();
      return Response.json(agents);
    }

    // Serve static HTML dashboard
    return new Response(dashboardHTML, {
      headers: { 'Content-Type': 'text/html' }
    });
  }
});
```

#### Credential Audit Trail

**When a skill accesses credentials:**
```sql
INSERT INTO events (event_type, actor_id, target_id, summary, metadata)
VALUES ('credential_accessed', 'session-abc', 'tado-api-key',
        'Tado skill requested API key for heating control',
        '{"skill": "Tado", "credential": "tado-api-key", "granted": true}');
```

**Query credential access:**
```bash
# Which skills accessed which credentials?
blackboard observe --events --type credential_accessed --since "1 month ago"

# Has skill X ever accessed credential Y?
blackboard observe --events --type credential_accessed --metadata '{"skill": "Email", "credential": "gmail-password"}'
```

**Credential scoping enforcement:**
```typescript
// In MCP server or skill runtime
async function getCredential(skillName: string, credentialName: string) {
  const scoping = await loadCredentialScoping(); // From settings.json

  if (!scoping[skillName]?.includes(credentialName)) {
    await bb.events.append({
      eventType: 'credential_denied',
      actorId: sessionId,
      targetId: credentialName,
      summary: `${skillName} denied access to ${credentialName}`,
      metadata: { skill: skillName, credential: credentialName, reason: 'not_in_scope' }
    });
    throw new Error(`Credential access denied`);
  }

  await bb.events.append({
    eventType: 'credential_accessed',
    actorId: sessionId,
    targetId: credentialName,
    summary: `${skillName} accessed ${credentialName}`,
    metadata: { skill: skillName, credential: credentialName, granted: true }
  });

  return await Keychain.get(credentialName);
}
```

### Implementation Steps

1. **Implement `blackboard observe` CLI** with all subcommands (--heartbeats, --events, --fts, --since, --agent, --aggregate)
2. **Implement `blackboard serve` web dashboard** (Bun HTTP server + static HTML)
3. **Add WebSocket support** for live event streaming to dashboard
4. **Add credential scoping config** to settings.json (skill → allowed credentials mapping)
5. **Instrument credential access** in MCP servers and skills (append events on access)
6. **Add `credential_accessed` and `credential_denied` event types**
7. **Create dashboard UI components** (agent status, heartbeat timeline, event stream, cost charts)
8. **Add cost aggregation queries** to blackboard library
9. **Write integration tests** (CLI output, dashboard API endpoints)
10. **Document observability workflows** (how to use observe/serve for debugging)

### Success Criteria

**From council + blackboard-specific:**

- [ ] `blackboard observe --heartbeats` shows last/next check, cost
- [ ] `blackboard observe --since "yesterday"` answers "what happened while I was away?"
- [ ] `blackboard serve` dashboard accessible at localhost:7878
- [ ] Dashboard shows real-time agent status and live event stream
- [ ] Cost tracking shows daily/weekly trends with breakdown by model
- [ ] FTS5 search in CLI and dashboard returns results in <100ms
- [ ] Credential access logged for all skills (audit trail complete)
- [ ] Credential scoping blocks unauthorized access attempts
- [ ] User never asks "Why didn't Ivy tell me?" (observability prevents this)
- [ ] Dashboard works without external dependencies (self-contained)

---

## Phase 4: Read-Only Integrations — Month 2+ (Conditional)

### What Changes from Council Spec

**Council spec said:**
- Email digest adapter (nightly summary, not live IMAP)
- Calendar-aware heartbeat (check upcoming meetings, prep notes)
- No bidirectional calendar modification
- Skip in v1, don't even scope it

**Blackboard integration adds:**
- Email digests become `work_items` with `source='email'`
- Calendar events become `work_items` with `source='calendar'`
- Agents query `work_items` table to see external data
- Content filtering (from pai-content-filter) applied before inserting work items
- External data is just another "source" — no special handling in agent logic

### Blackboard Integration

#### Work Items Table Schema

**Email work item:**
```sql
INSERT INTO work_items (
  item_id, project_id, title, description, source,
  status, priority, claimed_by, metadata
) VALUES (
  'email-2026-02-03-001', NULL,
  'Review: OpenClaw security analysis from Angela',
  'Email from angela@example.com with attachment: openclaw-audit.pdf',
  'email',
  'pending', 2, NULL,
  '{"sender": "angela@example.com", "subject": "Security audit complete", "date": "2026-02-03 09:30:00", "has_attachment": true}'
);
```

**Calendar work item:**
```sql
INSERT INTO work_items (
  item_id, project_id, title, description, source,
  status, priority, claimed_by, metadata
) VALUES (
  'calendar-2026-02-03-002', NULL,
  'Meeting: Architecture review at 3pm',
  'Recurring meeting with engineering team to review Ivy blackboard spec',
  'calendar',
  'pending', 1, NULL,
  '{"start": "2026-02-03 15:00:00", "end": "2026-02-03 16:00:00", "attendees": ["user@example.com", "team@example.com"], "location": "Zoom"}'
);
```

**Agent query interface:**
```sql
-- Heartbeat: "Check for upcoming calendar conflicts"
SELECT * FROM work_items
WHERE source = 'calendar'
  AND status = 'pending'
  AND json_extract(metadata, '$.start') BETWEEN datetime('now') AND datetime('now', '+2 hours')
ORDER BY json_extract(metadata, '$.start');

-- Heartbeat: "Summarize unread emails about security"
SELECT * FROM work_items
WHERE source = 'email'
  AND status = 'pending'
  AND (title LIKE '%security%' OR description LIKE '%security%')
ORDER BY json_extract(metadata, '$.date') DESC
LIMIT 10;
```

#### Email Digest Adapter

**Runs nightly via launchd (e.g., 08:00):**

```typescript
#!/usr/bin/env bun
// email-digest-adapter.ts

import { Blackboard } from '~/work/DA/KAI/lib/blackboard';
import { EmailClient } from '~/work/DA/KAI/skills/Email/client';
import { contentFilter } from 'pai-content-filter';

const bb = new Blackboard('~/.pai/blackboard/local.db');
const email = new EmailClient();

// Fetch unread emails since last run
const lastRun = await bb.events.getLatest({ eventType: 'email_digest_run' });
const since = lastRun?.timestamp || new Date(Date.now() - 24 * 60 * 60 * 1000);

const unreadEmails = await email.fetchUnread({ since, folder: 'INBOX' });

for (const msg of unreadEmails) {
  // Content filtering (prompt injection defense)
  const filtered = await contentFilter({
    subject: msg.subject,
    body: msg.body,
    sender: msg.from
  });

  if (filtered.blocked) {
    await bb.events.append({
      eventType: 'email_filtered',
      summary: `Blocked suspicious email: ${filtered.reason}`,
      metadata: { messageId: msg.id, sender: msg.from, reason: filtered.reason }
    });
    continue;
  }

  // Create work item
  await bb.workItems.create({
    title: `Review: ${msg.subject}`,
    description: `Email from ${msg.from}\n\n${msg.body.slice(0, 500)}...`,
    source: 'email',
    priority: calculatePriority(msg), // Heuristic based on sender, subject
    metadata: {
      messageId: msg.id,
      sender: msg.from,
      subject: msg.subject,
      date: msg.date,
      hasAttachment: msg.attachments.length > 0
    }
  });
}

// Log completion
await bb.events.append({
  eventType: 'email_digest_run',
  summary: `Processed ${unreadEmails.length} unread emails, created ${workItemsCreated} work items`,
  metadata: { emailsProcessed: unreadEmails.length, workItemsCreated, emailsFiltered: filtered.length }
});
```

#### Calendar Adapter

**Runs hourly via launchd:**

```typescript
#!/usr/bin/env bun
// calendar-adapter.ts

import { Blackboard } from '~/work/DA/KAI/lib/blackboard';
import { CalendarClient } from '~/work/DA/KAI/skills/Calendar/client';
import { contentFilter } from 'pai-content-filter';

const bb = new Blackboard('~/.pai/blackboard/local.db');
const calendar = new CalendarClient();

// Fetch events in next 24 hours
const events = await calendar.fetchEvents({
  start: new Date(),
  end: new Date(Date.now() + 24 * 60 * 60 * 1000)
});

for (const event of events) {
  // Check if work item already exists (dedupe)
  const existing = await bb.workItems.findOne({
    source: 'calendar',
    'metadata.eventId': event.id
  });

  if (existing) continue; // Skip duplicates

  // Content filtering (event titles/descriptions could be injection vectors)
  const filtered = await contentFilter({
    title: event.title,
    description: event.description
  });

  if (filtered.blocked) {
    await bb.events.append({
      eventType: 'calendar_filtered',
      summary: `Blocked suspicious calendar event: ${filtered.reason}`,
      metadata: { eventId: event.id, title: event.title, reason: filtered.reason }
    });
    continue;
  }

  // Create work item
  await bb.workItems.create({
    title: `Meeting: ${event.title}`,
    description: event.description || 'No description',
    source: 'calendar',
    priority: calculatePriority(event), // Higher priority for soon-starting meetings
    metadata: {
      eventId: event.id,
      start: event.start,
      end: event.end,
      attendees: event.attendees,
      location: event.location
    }
  });
}

await bb.events.append({
  eventType: 'calendar_sync_run',
  summary: `Synced ${events.length} calendar events, created ${workItemsCreated} work items`,
  metadata: { eventsProcessed: events.length, workItemsCreated }
});
```

#### Heartbeat Integration

**Sentinel queries work_items during heartbeat checks:**

```typescript
// In IVY_HEARTBEAT.md checklist:
// - Check for calendar conflicts in next 2 hours
// - Summarize high-priority unread emails

// Sentinel implementation:
async function checkCalendarConflicts() {
  const conflicts = await bb.query(`
    SELECT w1.title, w2.title, w1.metadata
    FROM work_items w1
    JOIN work_items w2 ON w1.id != w2.id
    WHERE w1.source = 'calendar' AND w2.source = 'calendar'
      AND w1.status = 'pending' AND w2.status = 'pending'
      AND json_extract(w1.metadata, '$.start') < json_extract(w2.metadata, '$.end')
      AND json_extract(w2.metadata, '$.start') < json_extract(w1.metadata, '$.end')
      AND json_extract(w1.metadata, '$.start') BETWEEN datetime('now') AND datetime('now', '+2 hours')
  `);

  if (conflicts.length > 0) {
    return {
      alert: true,
      message: `Calendar conflict detected: ${conflicts.length} overlapping meetings`,
      severity: 'high'
    };
  }

  return { alert: false };
}
```

### Implementation Steps

1. **Phase 1-3 must be complete** (heartbeat + memory + observability foundation)
2. **Extend work_items table** with `source` field (if not already present)
3. **Add new source types** to CHECK constraint: `email`, `calendar`
4. **Implement email digest adapter** (nightly run via launchd)
5. **Implement calendar adapter** (hourly run via launchd)
6. **Integrate pai-content-filter** for all external content
7. **Add `email_digest_run`, `calendar_sync_run`, `*_filtered` event types**
8. **Update Sentinel checklist** to query work_items table
9. **Add `blackboard observe --work-items --source email`** command
10. **Write integration tests** (mock IMAP/calendar APIs, verify filtering)
11. **Document read-only constraint** (no email sending, no calendar modification)

### Success Criteria

**From council + blackboard-specific:**

- [ ] Email digest runs nightly without user intervention
- [ ] Unread emails become work_items queryable by agents
- [ ] Calendar events synced hourly as work_items
- [ ] Content filtering blocks all suspicious content (test with injection payloads)
- [ ] Heartbeat alerts on calendar conflicts detected via work_items query
- [ ] Email summaries delivered when high-priority emails detected
- [ ] No bidirectional operations (read-only verified in tests)
- [ ] Work items deduplicated (no duplicate calendar events or emails)
- [ ] User can query "show me unread security emails" via blackboard CLI
- [ ] Integration doesn't increase prompt injection risk (verified by security review)

---

## Cross-Cutting Concerns

### Security Model

**Red lines from council debate:**

1. **Trust Boundary Integrity**
   - Skills and external content never run with identical privilege
   - Blackboard access is read/append for most agents, write for privileged operations only
   - No external content executed as instructions (data-only)

2. **No Persistent Network Services**
   - Blackboard adapters (email, calendar) fire-and-forget via launchd
   - `blackboard serve` dashboard is local-only (no remote access without explicit tunnel)
   - No WebSocket listeners for external connections

3. **Content Filtering**
   - All external data (emails, calendar events) filtered before entering blackboard
   - pai-content-filter applied at adapter boundary
   - Blocked content logged as events for audit

4. **Credential Isolation**
   - Per-skill scoping enforced and logged
   - Keychain for sensitive credentials (never in blackboard)
   - Credential access events provide audit trail

5. **Observability Before Autonomy**
   - All blackboard operations logged as events
   - Cost visibility per feature
   - User can always answer "what did agents do while I was away?"

**Blackboard-specific security:**

- **SQLite in WAL mode** — Multiple readers, single writer (no lock contention)
- **No SQL injection** — Parameterized queries only, TypeScript ORM layer
- **Permissions** — `~/.pai/blackboard/local.db` owned by user, mode 0600
- **No remote access** — Blackboard is local-only (SSH tunnel if remote needed)

### Blackboard Schema Extensions

**Current schema (from issue #78) likely includes:**

```sql
CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  agent_name TEXT NOT NULL,
  pid INTEGER,
  parent_id TEXT,
  project TEXT,
  current_work TEXT,
  status TEXT CHECK(status IN ('active', 'idle', 'completed', 'failed')) DEFAULT 'active',
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT CHECK(status IN ('active', 'paused', 'completed')) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE work_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT UNIQUE NOT NULL,
  project_id TEXT,
  title TEXT NOT NULL,
  description TEXT,
  source TEXT CHECK(source IN ('github', 'local', 'operator')) DEFAULT 'local',
  status TEXT CHECK(status IN ('pending', 'in_progress', 'completed', 'blocked')) DEFAULT 'pending',
  priority INTEGER DEFAULT 3,
  claimed_by TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata TEXT, -- JSON
  FOREIGN KEY (project_id) REFERENCES projects(project_id),
  FOREIGN KEY (claimed_by) REFERENCES agents(session_id)
);

CREATE TABLE heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  progress TEXT,
  work_item_id TEXT,
  metadata TEXT, -- JSON (cost, model, alerts, etc.)
  FOREIGN KEY (session_id) REFERENCES agents(session_id),
  FOREIGN KEY (work_item_id) REFERENCES work_items(item_id)
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  actor_id TEXT, -- session_id of agent that created event
  target_id TEXT, -- optional: work_item_id, credential name, etc.
  summary TEXT NOT NULL,
  metadata TEXT, -- JSON
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_id) REFERENCES agents(session_id)
);

CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_type ON events(event_type);
CREATE INDEX idx_events_actor ON events(actor_id);
CREATE INDEX idx_heartbeats_session ON heartbeats(session_id);
CREATE INDEX idx_work_items_status ON work_items(status);
CREATE INDEX idx_work_items_source ON work_items(source);
```

**Extensions needed for Ivy (new constraints and event types):**

```sql
-- Extend source types
ALTER TABLE work_items DROP CONSTRAINT work_items_source_check;
ALTER TABLE work_items ADD CONSTRAINT work_items_source_check
  CHECK(source IN ('github', 'local', 'operator', 'email', 'calendar'));

-- Extend event_type CHECK constraint (add all new types)
-- Note: SQLite doesn't support ALTER CONSTRAINT, so this would be:
-- 1. Create new table with updated constraint
-- 2. Copy data
-- 3. Drop old table
-- 4. Rename new table
-- For now, documenting the new types:

-- NEW EVENT TYPES:
-- Phase 1:
--   heartbeat_check, heartbeat_alert, heartbeat_skipped
-- Phase 2:
--   session_started, session_activity, session_ended,
--   fact_extracted, pattern_detected
-- Phase 3:
--   credential_accessed, credential_denied
-- Phase 4:
--   email_digest_run, calendar_sync_run,
--   email_filtered, calendar_filtered

-- Add FTS5 virtual table for events (Phase 2)
CREATE VIRTUAL TABLE events_fts USING fts5(
  summary,
  metadata,
  content='events',
  content_rowid='id'
);

-- Triggers for FTS5
CREATE TRIGGER events_fts_insert AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, summary, metadata)
  VALUES (new.id, new.summary, new.metadata);
END;

CREATE TRIGGER events_fts_delete AFTER DELETE ON events BEGIN
  DELETE FROM events_fts WHERE rowid = old.id;
END;

CREATE TRIGGER events_fts_update AFTER UPDATE ON events BEGIN
  DELETE FROM events_fts WHERE rowid = old.id;
  INSERT INTO events_fts(rowid, summary, metadata)
  VALUES (new.id, new.summary, new.metadata);
END;
```

**Migration strategy:**

1. **Detect schema version** (add `schema_version` table if needed)
2. **Apply migrations incrementally** (Phase 1 → 2 → 3 → 4)
3. **Each phase migration script** (e.g., `migrations/001-phase1-heartbeat.sql`)
4. **Blackboard library checks version** on startup, auto-migrates if needed

### Dependencies Between Phases

**Strict ordering:**

```
Phase 1 (Heartbeat)
  ↓ (requires blackboard operational + event logging working)
Phase 2 (Memory)
  ↓ (requires post-session hook + FTS5 + event extraction working)
Phase 3 (Observability)
  ↓ (requires events + heartbeats tables populated with real data)
Phase 4 (Integrations)
```

**Cannot parallelize phases** because:
- Phase 2 depends on Phase 1's event logging patterns
- Phase 3 depends on Phase 2's fact extraction to have meaningful data to observe
- Phase 4 depends on Phase 3's security model being proven in production

**Can parallelize within phases:**
- Phase 1: Sentinel extension + launchd config + IVY_HEARTBEAT.md parser (parallel)
- Phase 2: Post-session hook + FTS5 schema + fact extractor (mostly parallel, integrate at end)
- Phase 3: CLI + web dashboard + credential audit (parallel)
- Phase 4: Email adapter + calendar adapter (parallel)

### Migration from Flat Files

**If any existing flat-file data needs migration:**

**From ACR session transcripts:**
```bash
# One-time migration script
for file in ~/.claude/sessions/*.jsonl; do
  session_id=$(basename "$file" .jsonl)
  blackboard import --session "$file" --session-id "$session_id"
done
```

**From existing MEMORY files:**
```bash
# One-time extraction of facts from MEMORY/DAILY/*.md
for file in MEMORY/DAILY/*.md; do
  date=$(basename "$file" .md)
  blackboard import --daily-log "$file" --date "$date"
done
```

**From existing Sentinel logs:**
```bash
# If Sentinel had prior logs (unlikely, but for completeness)
blackboard import --sentinel-logs ~/.claude/sentinel.log
```

**Migration script responsibilities:**
1. Parse old format (JSONL, Markdown, etc.)
2. Extract structured data (facts, events, timestamps)
3. Insert into blackboard with proper event types
4. Preserve timestamps (use original, not import time)
5. Mark as imported in metadata (e.g., `{"imported": true, "source_file": "..."}`)
6. Verify import (count records, spot-check)
7. Archive original files (don't delete, move to `~/.pai/archive/`)

---

## Implementation Timeline

**Week 1: Phase 1 (Heartbeat)**
- Days 1-2: Blackboard schema + TypeScript library
- Days 3-4: Sentinel extension + launchd plist
- Day 5: Integration testing + documentation

**Weeks 2-3: Phase 2 (Memory)**
- Week 2, Days 1-3: FTS5 schema + post-session hook skeleton
- Week 2, Days 4-5: Fact extractor + pattern detector (haiku-based)
- Week 3, Days 1-2: ACR integration + daily log export
- Week 3, Days 3-4: Integration testing + migration scripts
- Week 3, Day 5: Documentation + polish

**Week 4: Phase 3 (Observability)**
- Days 1-2: `blackboard observe` CLI (all subcommands)
- Days 3-4: `blackboard serve` web dashboard + WebSocket
- Day 5: Credential audit + integration testing

**Month 2+ (Conditional): Phase 4 (Integrations)**
- Week 1: Email digest adapter + content filtering integration
- Week 2: Calendar adapter + deduplication logic
- Week 3: Heartbeat integration + work_items queries
- Week 4: Testing + security review + documentation

---

## Success Metrics (Overall)

**By end of Phase 3 (month 1):**

- [ ] Ivy heartbeat runs reliably without user intervention
- [ ] User can ask "what did Ivy do today?" and get complete answer
- [ ] Keyword search finds exact phrases from past sessions
- [ ] Cost is visible and under control (<$1/day average)
- [ ] No flat files competing with blackboard (single source of truth)
- [ ] Dashboard accessible and useful for debugging
- [ ] Credential access is auditable and scoped

**By end of Phase 4 (month 2, if approved):**

- [ ] Email and calendar data integrated without increasing security risk
- [ ] Heartbeat leverages external data (calendar conflicts, email urgency)
- [ ] Work items queryable by any agent without special-case code
- [ ] Content filtering blocks 100% of test injection payloads
- [ ] Read-only constraint verified (no bidirectional operations)

**Qualitative success:**

- User feels Ivy is "alive" but not intrusive (sparse, high-signal alerts)
- User trusts Ivy because observability answers "why did you do that?"
- Developer onboarding is faster (blackboard provides clear data model)
- Future features integrate easily (blackboard is extensible foundation)

---

## Open Questions for Implementation

1. **Compaction strategy for events table?**
   - Council debate (Arbor memory) suggested 90-day active window + monthly summaries
   - Blackboard events grow unbounded without compaction
   - Proposal: Archive events older than 90 days, keep summaries in `events_archive` table

2. **Should blackboard support per-project instances?**
   - Issue #78 mentions `.blackboard/local.db` per-project
   - Operator-wide `~/.pai/blackboard/local.db` is primary
   - Per-project: Useful for project-specific work items, or unnecessary complexity?

3. **How does RLM integration work?**
   - Council debate mentions RLM mega-queries over event log
   - Is RLM querying blackboard directly, or does blackboard export to RLM?
   - Proposal: Blackboard provides `events` table as RLM data source

4. **Credential scoping config format?**
   - settings.json needs `credentialScoping` field
   - Format: `{ "Tado": ["tado-api-key"], "Email": ["gmail-password", "smtp-password"] }`
   - Or more granular: per-operation scoping?

5. **Dashboard authentication?**
   - `blackboard serve` runs on localhost — no auth needed?
   - Or add basic auth for remote access via SSH tunnel?
   - Proposal: localhost-only by default, document SSH tunnel setup

6. **Event retention policy?**
   - How long to keep events before archiving?
   - Proposal: 90 days active, then archive (matches Arbor memory council debate)
   - User-configurable via settings.json?

7. **Blackboard library package?**
   - Should `~/work/DA/KAI/lib/blackboard` be its own npm package?
   - Or stay in PAI monorepo?
   - Proposal: Stay in monorepo initially, extract if pai-collab needs it

---

## Conclusion

This specification integrates the council's 4-phase Ivy evolution plan with the local blackboard architecture. The blackboard is not an additional layer — it's the **central nervous system** that makes all 4 phases work cohesively.

**Key decisions:**

1. **Blackboard replaces scattered flat files** — Single source of truth
2. **IVY_HEARTBEAT.md is config, not storage** — Results go to blackboard
3. **Daily logs are events table queries** — No separate Markdown files needed
4. **FTS5 on events gives keyword search for free** — No separate index infrastructure
5. **Work items are universal input queue** — Email, calendar, GitHub all become work_items
6. **`blackboard observe` replaces "what happened?"** — Single CLI for all observability
7. **New event types and source values extend the schema** — Documented for each phase

**This specification is ready for implementation.** Each phase has clear:
- Schema requirements
- Implementation steps
- Success criteria
- Dependencies
- Security constraints

The Engineer can now build Phase 1 (heartbeat) with confidence that Phases 2-4 will integrate cleanly on the same foundation.

---

**Next action:** Review this spec with PAI maintainers, then begin Phase 1 implementation.
