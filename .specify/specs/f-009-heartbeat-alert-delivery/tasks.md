# F-009: Heartbeat Alert Delivery — Tasks

## Task 1: Create alert types
**File:** `src/alert/types.ts`
- [ ] Define `DispatchResult` interface (delivered, failed, suppressed arrays)
- [ ] Define `ChannelHandler` type: `(result: CheckResult) => Promise<boolean>`
- [ ] Define `ActiveHoursConfig` with start/end hour

## Task 2: Implement active hours check
**File:** `src/alert/hours.ts`
- [ ] Implement `isWithinActiveHours(now?: Date): boolean`
- [ ] Default hours: 08:00–22:00
- [ ] Accept optional config override
- [ ] Export for testing

## Task 3: Implement terminal notification
**File:** `src/alert/terminal.ts`
- [ ] Implement `notifyTerminal(result: CheckResult): Promise<boolean>`
- [ ] Use `Bun.spawn(['osascript', ...])` for macOS notification
- [ ] Title: "Ivy Heartbeat", subtitle: severity, message: summary
- [ ] Return false on failure (non-macOS, osascript error)

## Task 4: Implement voice notification
**File:** `src/alert/voice.ts`
- [ ] Implement `notifyVoice(result: CheckResult): Promise<boolean>`
- [ ] POST to `http://localhost:8888/notify`
- [ ] 3-second timeout via AbortController
- [ ] Return false on failure (server down, timeout)

## Task 5: Implement email stub
**File:** `src/alert/email.ts`
- [ ] Implement `notifyEmail(result: CheckResult): Promise<boolean>`
- [ ] For MVP: log "email not configured" and return false
- [ ] Structure ready for future SMTP implementation

## Task 6: Create dispatcher
**File:** `src/alert/dispatcher.ts`
- [ ] Implement `dispatchAlert(result: CheckResult, channels: Channel[]): Promise<DispatchResult>`
- [ ] Check active hours first — if outside, suppress all channels
- [ ] Route to channel handlers based on channels array
- [ ] Collect delivered/failed/suppressed results
- [ ] All channels fire independently (one failure doesn't block others)

## Task 7: Integrate dispatcher into runner
**File:** `src/check/runner.ts`
- [ ] After each result with status 'alert' or 'error', call `dispatchAlert()`
- [ ] Record dispatch result as blackboard event
- [ ] Skip dispatch in dry-run mode

## Task 8: Write tests
**File:** `test/alert.test.ts`
- [ ] Test: terminal notification calls osascript
- [ ] Test: voice notification POSTs to voice server
- [ ] Test: email stub returns false
- [ ] Test: dispatcher routes to correct channels
- [ ] Test: OK results not dispatched
- [ ] Test: active hours suppression
- [ ] Test: voice failure doesn't fail dispatch
- [ ] Test: dispatch event recorded to blackboard
- [ ] Test: dry-run does not dispatch
