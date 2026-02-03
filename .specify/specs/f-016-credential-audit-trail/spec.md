# F-016: Credential Audit Trail

## What
Instrument credential access logging to record credential_accessed and credential_denied
events in the blackboard. Provide a CLI command to query credential events and a
configurable per-skill scoping config.

## Why
Security visibility — know which tools accessed which credentials and when.
Supports compliance auditing and anomaly detection.

## Acceptance Criteria
1. `logCredentialAccess()` records event with skill name, credential type, outcome
2. `logCredentialDenied()` records denial event with reason
3. Credential config loaded from `~/.pai/credential-scopes.json` (or default allow-all)
4. `isCredentialAllowed(skill, credentialType)` checks scope config
5. `ivy-heartbeat observe --type credential` shows credential events
6. Tests cover access logging, denial logging, scope checking
