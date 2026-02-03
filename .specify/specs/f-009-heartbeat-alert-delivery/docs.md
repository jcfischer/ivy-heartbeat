# F-009: Heartbeat Alert Delivery — Documentation

## Overview

When a check produces `alert` or `error` status, the alert delivery system dispatches notifications through the item's configured channels. Supports terminal (macOS), voice (PAI voice server), and email (stub for MVP). Respects active hours (08:00–22:00 default).

## Architecture

```
src/alert/types.ts        — DispatchResult, ChannelHandler, ActiveHoursConfig
src/alert/hours.ts        — isWithinActiveHours()
src/alert/terminal.ts     — macOS osascript notification
src/alert/voice.ts        — POST to localhost:8888/notify (3s timeout)
src/alert/email.ts        — Stub (returns false, ready for SMTP)
src/alert/dispatcher.ts   — dispatchAlert() routes to channel handlers
src/check/runner.ts       — Calls dispatcher after alert/error results
```

## Channel Configuration

Each checklist item specifies its channels in the YAML config:
```yaml
channels: [terminal, voice]
```

Available channels: `terminal`, `voice`, `email`.

## Active Hours

Default: 08:00–22:00 system timezone. Outside this window, alerts are still recorded to the blackboard but notification delivery is suppressed.

## Failure Handling

- Each channel fires independently — one failure doesn't block others
- Voice server timeout: 3 seconds via AbortController
- Email stub always returns false (future SMTP implementation)
- Failed channels are logged in the dispatch event metadata, not as check failures

## Pre-Verification Checklist

- [x] Terminal notification fires via osascript on alert
- [x] Voice notification POSTs to localhost:8888 with 3s timeout
- [x] Email stub returns false (MVP)
- [x] Dispatcher routes to per-item configured channels
- [x] OK results produce no dispatch events
- [x] Active hours suppress delivery outside window
- [x] Failed channel does not fail the check
- [x] Dispatch events recorded to blackboard
- [x] dry-run does not dispatch any notifications
- [x] 123 tests pass (17 new alert tests)
