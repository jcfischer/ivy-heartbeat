# F-009: Heartbeat Alert Delivery — Plan

## File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `src/alert/types.ts` | CREATE | DispatchResult, AlertConfig types |
| `src/alert/dispatcher.ts` | CREATE | Channel routing and dispatch orchestration |
| `src/alert/terminal.ts` | CREATE | macOS osascript notification |
| `src/alert/voice.ts` | CREATE | PAI voice server POST |
| `src/alert/email.ts` | CREATE | Optional SMTP delivery (stub for MVP) |
| `src/alert/hours.ts` | CREATE | Active hours check |
| `src/check/runner.ts` | MODIFY | Call dispatcher after evaluation |
| `test/alert.test.ts` | CREATE | Alert delivery tests |

## Approach

The alert system is a post-evaluation pipeline. After each check result, if status is `alert` or `error`, the dispatcher routes to the item's configured channels. Each channel handler is independent — if one fails, others still fire.

For MVP:
- **Terminal**: `osascript` — no dependencies, works on macOS
- **Voice**: HTTP POST to localhost:8888 — existing PAI infrastructure
- **Email**: Stub that logs "email not configured" — full SMTP can come later

Active hours are hardcoded to 08:00–22:00 for MVP, with the structure to make them configurable later.

## Test Strategy

- Unit test: dispatcher routes to correct channels
- Unit test: OK results not dispatched
- Unit test: active hours suppression
- Unit test: voice server failure doesn't fail check
- Unit test: email stub logs skip
- Integration: dispatch events recorded to blackboard
- Mock: osascript and fetch for terminal/voice tests
