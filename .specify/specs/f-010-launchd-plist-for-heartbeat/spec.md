# F-010: launchd Plist for Heartbeat

## Overview

Generate and install a macOS launchd plist that runs `ivy-heartbeat check` on a configurable schedule. Provides `ivy-heartbeat schedule install` and `ivy-heartbeat schedule uninstall` commands. The plist uses `StartInterval` for periodic execution with stdout/stderr logging to a known location.

## User Scenarios

### S-1: Install Default Schedule
**Given** `ivy-heartbeat` is installed and working
**When** the user runs `ivy-heartbeat schedule install`
**Then** a launchd plist is generated at `~/Library/LaunchAgents/com.pai.ivy-heartbeat.plist`, loaded via `launchctl`, and the heartbeat begins running every 60 minutes

### S-2: Custom Interval
**Given** the user wants checks every 30 minutes
**When** `ivy-heartbeat schedule install --interval 30`
**Then** the plist is generated with `StartInterval` set to 1800 seconds

### S-3: Uninstall Schedule
**Given** the plist is installed and loaded
**When** `ivy-heartbeat schedule uninstall`
**Then** the agent is unloaded via `launchctl` and the plist file is removed

### S-4: Status Check
**Given** the user wants to know if the heartbeat is scheduled
**When** `ivy-heartbeat schedule status`
**Then** it prints whether the plist is installed, the interval, last run time, and next expected run

### S-5: Reinstall Updates Interval
**Given** the plist is already installed with 60-minute interval
**When** `ivy-heartbeat schedule install --interval 15`
**Then** the old plist is unloaded, a new one is generated with 15-minute interval, and it's loaded

### S-6: Dry Run
**Given** the user wants to preview the plist
**When** `ivy-heartbeat schedule install --dry-run`
**Then** the plist XML is printed to stdout without writing to disk or loading

## Functional Requirements

### FR-1: Plist Generation
Generate a standard launchd plist:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pai.ivy-heartbeat</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/bun</string>
    <string>/path/to/ivy-heartbeat/src/cli.ts</string>
    <string>check</string>
  </array>
  <key>StartInterval</key>
  <integer>3600</integer>
  <key>StandardOutPath</key>
  <string>~/.pai/logs/ivy-heartbeat.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>~/.pai/logs/ivy-heartbeat.stderr.log</string>
  <key>RunAtLoad</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

Key details:
- `ProgramArguments` uses absolute paths resolved at install time
- `bun` path resolved via `which bun`
- `StandardOutPath` and `StandardErrorPath` to `~/.pai/logs/`
- `RunAtLoad` ensures first run on login
- `PATH` includes homebrew locations

### FR-2: Install Command
```
ivy-heartbeat schedule install [--interval <minutes>] [--dry-run]
```

Steps:
1. Resolve absolute paths for `bun` and `cli.ts`
2. Create `~/.pai/logs/` directory if missing
3. Generate plist XML
4. Write to `~/Library/LaunchAgents/com.pai.ivy-heartbeat.plist`
5. Run `launchctl load <plist-path>`
6. Print confirmation with interval and next expected run

### FR-3: Uninstall Command
```
ivy-heartbeat schedule uninstall
```

Steps:
1. Run `launchctl unload <plist-path>`
2. Remove the plist file
3. Print confirmation

If plist doesn't exist, print "Not installed" and exit cleanly.

### FR-4: Status Command
```
ivy-heartbeat schedule status
```

Output:
```
ivy-heartbeat schedule
  Status:   installed
  Interval: 60 minutes
  Plist:    ~/Library/LaunchAgents/com.pai.ivy-heartbeat.plist
  Logs:     ~/.pai/logs/ivy-heartbeat.stdout.log
```

Or if not installed:
```
ivy-heartbeat schedule
  Status: not installed
  Run 'ivy-heartbeat schedule install' to start
```

### FR-5: JSON Output
With `--json`:
```json
{
  "installed": true,
  "interval": 60,
  "plistPath": "/Users/user/Library/LaunchAgents/com.pai.ivy-heartbeat.plist",
  "logPath": "/Users/user/.pai/logs/ivy-heartbeat.stdout.log"
}
```

### FR-6: Path Resolution
All paths in the plist must be absolute:
- `bun`: resolved via `which bun` at install time
- `cli.ts`: resolved relative to the ivy-heartbeat package location
- Logs: expand `~` to absolute home path

If `bun` is not found, print error and exit.

## Architecture

```
src/schedule/plist.ts      — Plist XML generation (NEW)
src/schedule/launchctl.ts  — launchctl load/unload wrappers (NEW)
src/commands/schedule.ts   — CLI command: install, uninstall, status (NEW)
src/cli.ts                 — Register schedule command
```

## Dependencies
- F-007 (Heartbeat check command) — complete

## Success Criteria

1. `ivy-heartbeat schedule install` writes a valid plist and loads it
2. `ivy-heartbeat schedule uninstall` removes and unloads the plist
3. `ivy-heartbeat schedule status` reports install state accurately
4. Custom interval via `--interval` sets correct `StartInterval`
5. `--dry-run` prints plist XML without side effects
6. All paths in plist are absolute (no ~ or relative)
7. `~/.pai/logs/` directory created if missing
8. Reinstall correctly unloads old before loading new
9. Missing bun binary produces a clear error message
