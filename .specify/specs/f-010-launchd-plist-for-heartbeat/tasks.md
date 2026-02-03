# F-010: launchd Plist for Heartbeat — Tasks

## Task 1: Create plist generator
**File:** `src/schedule/plist.ts`
- [ ] Implement `generatePlist(config: PlistConfig): string`
- [ ] Accept: bunPath, cliPath, interval (seconds), logDir
- [ ] Return valid XML plist string
- [ ] All paths must be absolute (no ~ expansion in XML)
- [ ] Include Label, ProgramArguments, StartInterval, StandardOutPath, StandardErrorPath, RunAtLoad, EnvironmentVariables

## Task 2: Create launchctl wrapper
**File:** `src/schedule/launchctl.ts`
- [ ] Implement `loadPlist(plistPath: string): Promise<void>` — runs `launchctl load`
- [ ] Implement `unloadPlist(plistPath: string): Promise<void>` — runs `launchctl unload`
- [ ] Implement `isLoaded(label: string): Promise<boolean>` — runs `launchctl list | grep`
- [ ] All use `Bun.spawn()` for subprocess execution
- [ ] Handle errors (not found, already loaded/unloaded)

## Task 3: Create schedule CLI command
**File:** `src/commands/schedule.ts`
- [ ] Implement `registerScheduleCommand(parent, getContext)`
- [ ] Subcommand `install`: resolve paths, generate plist, write file, launchctl load
- [ ] Subcommand `uninstall`: launchctl unload, remove file
- [ ] Subcommand `status`: check plist exists, print info
- [ ] Option `--interval <minutes>` on install (default: 60)
- [ ] Option `--dry-run` on install (print XML, don't write)
- [ ] Support `--json` output via global flag

## Task 4: Wire into CLI
**File:** `src/cli.ts`
- [ ] Import `registerScheduleCommand`
- [ ] Call `registerScheduleCommand(program, getContext)`

## Task 5: Path resolution utilities
**File:** `src/schedule/plist.ts` (or separate utils)
- [ ] Resolve `bun` path via `which bun` (Bun.spawn)
- [ ] Resolve `cli.ts` path relative to package
- [ ] Resolve log directory: expand `~/.pai/logs/` to absolute
- [ ] Create log directory if missing (`mkdirSync` with `recursive: true`)
- [ ] Resolve plist path: `~/Library/LaunchAgents/com.pai.ivy-heartbeat.plist`

## Task 6: Write tests
**File:** `test/schedule.test.ts`
- [ ] Test: plist XML contains correct label
- [ ] Test: plist XML contains absolute bun path
- [ ] Test: plist XML contains correct interval in seconds
- [ ] Test: plist XML contains log paths
- [ ] Test: interval conversion (30 min → 1800 sec)
- [ ] Test: status reports not installed when plist missing
- [ ] Test: dry-run returns XML string without file IO
