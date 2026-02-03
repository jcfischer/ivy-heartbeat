# F-017: Email Digest Adapter

## What
Replace the email evaluator stub with a real implementation that checks for
unread/unresponded emails via IMAP, determines if action is needed based on
age and sender relevance, and returns alert/ok status.

## MVP Approach
Since full IMAP integration is complex and requires credentials, the MVP
implements a configurable evaluator that:
1. Checks if IMAP is configured (env vars or config)
2. If configured: connects, counts unread emails matching filters, alerts if threshold exceeded
3. If not configured: returns ok with "not configured" message (graceful degradation)

The evaluator supports config fields in the checklist item:
- `imap_host`, `imap_port`, `imap_user` — connection settings
- `max_unread` — alert threshold (default: 10)
- `max_age_hours` — only count emails newer than this (default: 48)
- `from_filter` — comma-separated sender patterns to match

## Acceptance Criteria
1. Email evaluator checks IMAP when configured
2. Returns alert when unread count exceeds threshold
3. Returns ok when within threshold or not configured
4. Gracefully handles connection failures (returns error status, doesn't crash)
5. Respects max_age_hours and from_filter config
6. Tests cover configured, unconfigured, threshold logic
