# F-010: launchd Plist for Heartbeat — Documentation

## Overview

`ivy-heartbeat schedule` manages a macOS launchd agent that runs `ivy-heartbeat check` on a configurable interval. This makes the heartbeat proactive — it runs automatically without the user needing to remember.

## Usage

```bash
# Install with default 60-minute interval
ivy-heartbeat schedule install

# Install with custom 15-minute interval
ivy-heartbeat schedule install --interval 15

# Preview the plist without installing
ivy-heartbeat schedule install --dry-run

# Check current status
ivy-heartbeat schedule status

# Uninstall
ivy-heartbeat schedule uninstall

# JSON output
ivy-heartbeat --json schedule status
```

## Architecture

```
src/schedule/plist.ts      — Plist XML generation, path resolution
src/schedule/launchctl.ts  — launchctl load/unload/isLoaded wrappers
src/commands/schedule.ts   — CLI command with install/uninstall/status
src/cli.ts                 — Wired via registerScheduleCommand
```

## Plist Location

- **Plist file**: `~/Library/LaunchAgents/com.pai.ivy-heartbeat.plist`
- **Stdout log**: `~/.pai/logs/ivy-heartbeat.stdout.log`
- **Stderr log**: `~/.pai/logs/ivy-heartbeat.stderr.log`

## Path Resolution

All paths in the generated plist are absolute (resolved at install time):
- `bun` via `which bun`
- `cli.ts` relative to the ivy-heartbeat package
- Log directory expanded from `~/.pai/logs/`

## Pre-Verification Checklist

- [x] `ivy-heartbeat schedule install` writes valid plist and loads it
- [x] `ivy-heartbeat schedule uninstall` removes and unloads
- [x] `ivy-heartbeat schedule status` reports install state
- [x] Custom interval via `--interval` works
- [x] `--dry-run` prints XML without side effects
- [x] All paths absolute (no ~ in plist XML)
- [x] `~/.pai/logs/` directory created if missing
- [x] Reinstall unloads old before loading new
- [x] Uninstall when not installed exits gracefully
- [x] launchctl confirms agent is loaded after install
- [x] 92 tests pass (21 new schedule tests)
