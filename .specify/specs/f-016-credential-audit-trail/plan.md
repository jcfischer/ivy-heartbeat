# F-016: Plan

## Approach
1. Create `src/credential/audit.ts` — logging functions
2. Create `src/credential/scope.ts` — scope config loading + checking
3. Create `src/credential/types.ts` — CredentialEvent, ScopeConfig types
4. Integrate with observe command — add --type credential filter
5. Tests in `test/credential.test.ts`

## Files
- `src/credential/types.ts` — Types
- `src/credential/audit.ts` — logCredentialAccess, logCredentialDenied
- `src/credential/scope.ts` — loadScopeConfig, isCredentialAllowed
- `test/credential.test.ts` — Tests
- `src/commands/observe.ts` — Add credential type convenience
