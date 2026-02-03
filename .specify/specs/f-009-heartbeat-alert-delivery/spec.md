# F-009: Heartbeat Alert Delivery

## Overview

When a heartbeat check produces an `alert` or `error` status, the alert delivery system dispatches notifications through configured channels. Each checklist item specifies its delivery channels (terminal, voice, email). The system respects active hours to avoid disturbing the user outside work time.

## User Scenarios

### S-1: Terminal Notification on Alert
**Given** a check produces `status: 'alert'` with `channels: ['terminal']`
**When** the check completes
**Then** a macOS terminal notification is displayed with the check name and summary

### S-2: Voice Notification on Alert
**Given** a check produces `status: 'alert'` with `channels: ['voice']`
**When** the check completes and the voice server is running
**Then** a voice announcement is made via the PAI voice server at localhost:8888

### S-3: Email Notification on Alert
**Given** a check produces `status: 'alert'` with `channels: ['email']` and SMTP is configured
**When** the check completes
**Then** an email is sent to the configured address with the alert details

### S-4: Multiple Channels
**Given** a check has `channels: ['terminal', 'voice']`
**When** the check produces an alert
**Then** both terminal and voice notifications are dispatched

### S-5: OK Results Not Notified
**Given** a check produces `status: 'ok'`
**When** the check completes
**Then** no notification is dispatched (only logged to blackboard)

### S-6: Outside Active Hours
**Given** the current time is 23:00 and active hours are 08:00-22:00
**When** an alert is produced
**Then** the alert is recorded to blackboard but notification delivery is suppressed
**And** a `notification_suppressed` event is logged with reason `outside_active_hours`

### S-7: Voice Server Unavailable
**Given** a voice notification is requested but localhost:8888 is not responding
**When** delivery is attempted
**Then** the failure is logged as a warning, other channels still deliver, and the check itself is not marked as failed

## Functional Requirements

### FR-1: Alert Dispatcher Interface
```typescript
interface AlertDispatcher {
  dispatch(result: CheckResult, channels: Channel[]): Promise<DispatchResult>;
}

interface DispatchResult {
  delivered: Channel[];
  failed: { channel: Channel; error: string }[];
  suppressed: Channel[];    // outside active hours
}
```

### FR-2: Terminal Notification
Use `osascript` to display a macOS notification:
```bash
osascript -e 'display notification "Calendar Conflicts: 2 overlapping meetings" with title "Ivy Heartbeat" subtitle "alert"'
```

Requires no additional dependencies. Falls back to `console.log` if `osascript` is not available.

### FR-3: Voice Notification
POST to the PAI voice server:
```typescript
await fetch('http://localhost:8888/notify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    message: `Heartbeat alert: ${result.summary}`,
  }),
});
```

Timeout: 3 seconds. On failure, log warning and continue.

### FR-4: Email Notification (Optional)
Only available if SMTP is configured in the checklist config or environment:
```yaml
# In IVY_HEARTBEAT.md item config
config:
  smtp_to: user@example.com
```

Uses `nodemailer` or equivalent. If SMTP is not configured, the email channel is silently skipped.

### FR-5: Active Hours Enforcement
Active hours default to 08:00–22:00 in the system timezone. Configurable via:
```yaml
# In IVY_HEARTBEAT.md top-level config (future)
# For now, hardcoded with config override
config:
  active_hours_start: 8
  active_hours_end: 22
```

Outside active hours:
- Alerts are still recorded to the blackboard
- Notification delivery is suppressed
- A `notification_suppressed` event is logged

### FR-6: Integration with Check Runner
After each check result in `runner.ts`, if the result has `status === 'alert'` or `status === 'error'`:
```typescript
if (result.status === 'alert' || result.status === 'error') {
  const dispatchResult = await dispatcher.dispatch(result, dueResult.item.channels);
  // Log dispatch result as event
}
```

### FR-7: Dispatch Event Recording
Each dispatch attempt is recorded:
```typescript
bb.appendEvent({
  actorId: sessionId,
  summary: `Alert dispatched: ${result.item.name} via ${dispatchResult.delivered.join(', ')}`,
  metadata: {
    checkName: result.item.name,
    channels: dispatchResult.delivered,
    failed: dispatchResult.failed,
    suppressed: dispatchResult.suppressed,
  },
});
```

## Architecture

```
src/alert/dispatcher.ts   — AlertDispatcher with channel routing (NEW)
src/alert/terminal.ts     — macOS osascript notification (NEW)
src/alert/voice.ts        — Voice server POST (NEW)
src/alert/email.ts        — Optional SMTP delivery (NEW)
src/alert/hours.ts        — Active hours check (NEW)
src/alert/types.ts        — DispatchResult, AlertConfig types (NEW)
src/check/runner.ts       — Integration: dispatch after evaluation
```

## Dependencies
- F-007 (Heartbeat check command) — complete

## Success Criteria

1. Terminal notification displays via osascript on alert
2. Voice notification POSTs to localhost:8888 on alert
3. Email sends via SMTP when configured
4. OK results produce no notifications
5. Channels are configurable per checklist item
6. Active hours suppress delivery outside window
7. Failed delivery channel does not fail the check
8. All dispatch attempts recorded as blackboard events
9. `--dry-run` does not dispatch any notifications
