# F-034: GitHub Webhook Ingestion

## Overview

PR status (review approved, changes requested, merge complete) is polled every 15 minutes even when nothing changes. This wastes rate limit quota and adds up to 15 minutes of latency to the review→rework→merge pipeline. This feature adds a webhook receiver endpoint that GitHub calls on PR events, writes directly to the blackboard event log, and wakes the evaluator.

**Repos affected:** `ivy-heartbeat` (webhook server), `ivy-blackboard` (webhook event type)

**Dependency:** Requires a stable public endpoint (ngrok for local dev, or server for production)

**Sprint:** Backlog | Priority: 7 (Backlog) | Effort: L | Grade: C

## Problem Statement

The `github-pr-review` evaluator polls PR status every 15 minutes:
- If nothing changed: wasted API call
- If a review was approved 1 minute after the last poll: 14 minutes of unnecessary wait before the merge work item is created

The root cause is polling — GitHub push events (webhooks) are the correct mechanism.

## Users & Stakeholders

- **Primary user:** PAI operator (Jens-Christian) — wants faster pipeline response to GitHub events
- **Pipeline maintainer:** Jens-Christian — wants to reduce GitHub API rate limit consumption

## User Scenarios

### Scenario 1: PR Approval Triggers Immediate Merge Work Item

**Given:** PR #48 has a review evaluator polling every 15 minutes
**And:** The webhook receiver is running and registered with GitHub
**When:** A reviewer approves PR #48 on GitHub
**Then:** GitHub sends a `pull_request_review` webhook within seconds
**And:** The webhook receiver validates the signature and writes a `github-pr-approved` event
**And:** The evaluator wakes and creates a merge work item within 30 seconds of approval
**Not:** 14 minutes later when the next poll fires

### Scenario 2: Invalid Webhook Signature Rejected

**Given:** The webhook receiver is running
**When:** A POST arrives at `/webhooks/github` with an invalid `X-Hub-Signature-256` header
**Then:** The server responds with `401 Unauthorized`
**And:** No event is written to the blackboard
**And:** A security event is logged

### Scenario 3: Unrecognized Event Type Gracefully Ignored

**Given:** GitHub sends a `push` webhook for a branch update
**When:** The webhook receiver processes it
**Then:** It responds `200 OK` (GitHub expects this)
**And:** No work item is created (push events are not handled)
**And:** An info log notes the unhandled event type

### Scenario 4: Local Development with ngrok

**Given:** Developer is running `ivy-heartbeat serve` locally
**And:** `ngrok http 7878` exposes the server publicly
**When:** The ngrok URL is registered as a GitHub webhook
**Then:** GitHub sends webhooks to the ngrok URL, which forwards to localhost:7878
**And:** The full webhook flow works in development without a production server

## Acceptance Criteria

1. `POST /webhooks/github` endpoint added to `ivy-heartbeat serve`
2. HMAC-SHA256 signature validation against `GITHUB_WEBHOOK_SECRET` env var
3. Handles event types: `pull_request`, `pull_request_review`, `push` (ignored)
4. On `pull_request_review` with action `submitted` and state `approved`: creates `pr-merge` work item
5. On `pull_request_review` with action `submitted` and state `changes_requested`: creates `pr-rework` work item
6. On `pull_request` with action `closed` and `merged: true`: writes completion event
7. All webhook events written to blackboard event log with `source: 'github-webhook'`
8. Invalid signature → 401, no event written
9. Existing 490 tests pass; new tests cover signature validation and event routing

## Technical Design

### Webhook Endpoint (ivy-heartbeat)

```typescript
// src/server/routes/webhooks.ts
router.post('/webhooks/github', async (req) => {
  const sig = req.headers['x-hub-signature-256'];
  const body = await req.text();

  if (!validateSignature(body, sig, process.env.GITHUB_WEBHOOK_SECRET)) {
    return new Response('Unauthorized', { status: 401 });
  }

  const event = req.headers['x-github-event'];
  const payload = JSON.parse(body);

  await handleGithubEvent(event, payload);
  return new Response('OK', { status: 200 });
});
```

### Event Handlers

```typescript
async function handleGithubEvent(event: string, payload: unknown) {
  switch (event) {
    case 'pull_request_review':
      await handlePRReview(payload as PRReviewPayload);
      break;
    case 'pull_request':
      await handlePREvent(payload as PRPayload);
      break;
    default:
      logger.info(`Unhandled GitHub event: ${event}`);
  }
}
```

### Setup Documentation

The spec includes instructions for:
1. Registering the webhook URL in GitHub repository settings
2. Setting `GITHUB_WEBHOOK_SECRET` in `.env`
3. Using ngrok for local development testing

## Risks

- **Stable endpoint required**: Local development needs ngrok; production needs a server. Currently ivy-heartbeat runs locally only.
- **Webhook delivery failures**: GitHub retries on 5xx — need idempotent handling
- **Rate limit improvement uncertain**: Need to measure actual savings vs effort

## Out of Scope

- Replacing ALL polling (calendar evaluator stays poll-based)
- Multi-repository webhook routing
- Webhook delivery dashboard
