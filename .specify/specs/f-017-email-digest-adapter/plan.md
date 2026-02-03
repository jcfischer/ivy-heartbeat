# F-017: Plan

## Files
- `src/evaluators/email.ts` — Real email evaluator
- `src/check/evaluators.ts` — Register the real evaluator
- `test/email-evaluator.test.ts` — Tests

## Approach
Since we can't easily test real IMAP in unit tests, the evaluator is
structured with a testable core:
1. `checkEmailConfig(item)` — validates config exists
2. `countUnreadEmails(config)` — IMAP query (real network call)
3. `evaluateEmailCheck(item)` — orchestrates: check config → count → threshold
4. The IMAP connection part is behind a function that can be overridden in tests
