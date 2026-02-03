# F-010: launchd Plist for Heartbeat — Plan

## File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `src/schedule/plist.ts` | CREATE | Plist XML generation from template |
| `src/schedule/launchctl.ts` | CREATE | launchctl load/unload/status wrappers |
| `src/commands/schedule.ts` | CREATE | CLI command: install, uninstall, status |
| `src/cli.ts` | MODIFY | Register schedule command |
| `test/schedule.test.ts` | CREATE | Schedule command tests |

## Approach

The schedule system generates a launchd plist XML file and manages it via `launchctl`. All paths are resolved to absolute at install time.

Key design decisions:
- **No active hours in plist**: launchd's `StartCalendarInterval` is limited. Active hours are enforced by the check command itself (F-009 handles suppression). The plist just fires on interval.
- **StartInterval over StartCalendarInterval**: Simpler, more predictable. Default 3600 seconds (1 hour).
- **RunAtLoad**: true — first check runs immediately on login/load.
- **Log rotation**: Not handled in plist. Logs to `~/.pai/logs/` and user can rotate manually or we add it later.

## Test Strategy

- Unit test: plist XML generation with correct paths
- Unit test: path resolution (bun, cli.ts, logs)
- Unit test: interval conversion (minutes to seconds)
- Unit test: status detection (plist exists/not)
- Integration: dry-run prints valid XML
- Note: actual launchctl load/unload not tested (requires system state)
