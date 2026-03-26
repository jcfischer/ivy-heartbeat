import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  evaluateMycelia,
  setMyceliaFetcher,
  resetMyceliaFetcher,
  setEmailSender,
  resetEmailSender,
  setMyceliaBlackboardAccessor,
  resetMyceliaBlackboardAccessor,
  type MyceliaApiFetcher,
  type EmailSender,
  type MyceliaBlackboardAccessor,
} from '../src/evaluators/mycelia.ts';
import type { ChecklistItem } from '../src/parser/types.ts';

// ============================================================================
// Test Factories and Utilities
// ============================================================================

function makeItem(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return {
    name: 'Mycelia Network',
    type: 'mycelia',
    severity: 'medium',
    channels: ['terminal'],
    enabled: true,
    description: 'Check Mycelia network for requests',
    config: {
      config_path: '/fake/config.json',
      agent_id: 'test-agent-id',
      email_to: 'test@example.com',
    },
    ...overrides,
  };
}

interface MyceliaRequestData {
  id: string;
  requester_id: string;
  title: string;
  request_type?: string;
  status?: string;
  response_count?: number;
  max_responses?: number;
  body?: string;
  responses?: Array<{
    id: string;
    responder_id: string;
    responder_name: string;
    body: string;
    confidence: number;
    created_at: string;
  }>;
}

function buildMyceliaRequest(overrides: Partial<MyceliaRequestData> = {}): MyceliaRequestData {
  return {
    id: 'req-1',
    requester_id: 'other-agent',
    title: 'Test request',
    request_type: 'review',
    status: 'open',
    response_count: 0,
    max_responses: 3,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    ...overrides,
  } as MyceliaRequestData;
}

function buildMyceliaResponse(overrides: Partial<{
  id: string;
  responder_id: string;
  responder_name: string;
  body: string;
  confidence: number;
}> = {}) {
  return {
    id: 'resp-1',
    responder_id: 'helper-agent',
    responder_name: 'Helper Bot',
    body: 'Test response',
    confidence: 8,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function createMockFetcher(
  requests: MyceliaRequestData[],
  agentTrustScore = 85,
  requestDetails?: Record<string, MyceliaRequestData>
): MyceliaApiFetcher {
  return async (path, _configPath) => {
    if (path === '/v1/requests') {
      return {
        ok: true,
        data: { requests },
      };
    }
    if (path === '/v1/agents/test-agent-id') {
      return {
        ok: true,
        data: { agent: { trust_score: agentTrustScore, request_count: 5, response_count: 10 } },
      };
    }
    if (requestDetails && path.startsWith('/v1/requests/')) {
      const requestId = path.split('/').pop();
      if (requestId && requestDetails[requestId]) {
        return {
          ok: true,
          data: { request: requestDetails[requestId] },
        };
      }
    }
    return null;
  };
}

interface TestSetup {
  sentEmails: Array<{ to: string; subject: string; body: string }>;
  appendedEvents: Array<{ summary: string; metadata?: Record<string, unknown> }>;
  storedMetadata: Record<string, unknown>;
  mockEmailSender: EmailSender;
  mockBlackboard: MyceliaBlackboardAccessor;
}

function setupMyceliaTest(): TestSetup {
  const sentEmails: Array<{ to: string; subject: string; body: string }> = [];
  const appendedEvents: Array<{ summary: string; metadata?: Record<string, unknown> }> = [];
  let storedMetadata: Record<string, unknown> = {};

  const mockEmailSender: EmailSender = async (to, subject, body) => {
    sentEmails.push({ to, subject, body });
    return true;
  };

  const mockBlackboard: MyceliaBlackboardAccessor = {
    findLastEventByCheckName: (_checkName: string) => {
      if (Object.keys(storedMetadata).length === 0) return null;
      return { metadata: JSON.stringify(storedMetadata) };
    },
    appendEvent: (opts) => {
      appendedEvents.push(opts);
      if (opts.metadata) {
        storedMetadata = opts.metadata;
      }
    },
  };

  return { sentEmails, appendedEvents, storedMetadata, mockEmailSender, mockBlackboard };
}

function expectEmailSent(
  emails: Array<{ to: string; subject: string; body: string }>,
  subjectIncludes: string,
  bodyIncludes?: string
) {
  expect(emails).toHaveLength(1);
  expect(emails[0].subject).toContain(subjectIncludes);
  if (bodyIncludes) {
    expect(emails[0].body).toContain(bodyIncludes);
  }
}

function expectNoEmail(emails: Array<{ to: string; subject: string; body: string }>) {
  expect(emails).toHaveLength(0);
}

// ============================================================================
// Tests
// ============================================================================

describe('Mycelia evaluator - deduplication', () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = setupMyceliaTest();
    setEmailSender(setup.mockEmailSender);
    setMyceliaBlackboardAccessor(setup.mockBlackboard);
  });

  afterEach(() => {
    resetEmailSender();
    resetMyceliaFetcher();
    resetMyceliaBlackboardAccessor();
  });

  test('alerts on first run with claimable requests', async () => {
    const mockFetcher = createMockFetcher([
      buildMyceliaRequest({ id: 'req-1', title: 'Help needed' }),
    ]);
    setMyceliaFetcher(mockFetcher);

    const result = await evaluateMycelia(makeItem());

    expect(result.status).toBe('alert');
    expect(result.summary).toContain('1 NEW request');
    expectEmailSent(setup.sentEmails, '[Mycelia] 1 NEW request available', 'Help needed');
    expect(setup.appendedEvents).toHaveLength(1);
    expect(setup.appendedEvents[0].metadata?.seenRequestIds).toEqual(['req-1']);
  });

  test('does NOT alert on second run with same requests', async () => {
    const mockFetcher = createMockFetcher([
      buildMyceliaRequest({ id: 'req-1', title: 'Help needed' }),
    ]);
    setMyceliaFetcher(mockFetcher);

    // First run
    await evaluateMycelia(makeItem());
    setup.sentEmails.length = 0;
    setup.appendedEvents.length = 0;

    // Second run with same request
    const result = await evaluateMycelia(makeItem());

    expect(result.status).toBe('ok');
    expect(result.summary).toContain('no new activity');
    expectNoEmail(setup.sentEmails);
  });

  test('alerts only on NEW requests when some are already seen', async () => {
    const mockFetcher = createMockFetcher([
      buildMyceliaRequest({ id: 'req-1', title: 'Old request' }),
      buildMyceliaRequest({ id: 'req-2', title: 'New request' }),
    ]);
    setMyceliaFetcher(mockFetcher);

    // Seed with req-1 already seen
    setup.storedMetadata.seenRequestIds = ['req-1'];
    setup.storedMetadata.responseCountsByRequestId = {};

    const result = await evaluateMycelia(makeItem());

    expect(result.status).toBe('alert');
    expect(result.summary).toContain('1 NEW request');
    expect(setup.sentEmails).toHaveLength(1);
    expect(setup.sentEmails[0].body).toContain('New request');
    expect(setup.sentEmails[0].body).not.toContain('Old request');
  });
});

describe('Mycelia evaluator - response tracking', () => {
  let setup: TestSetup;

  beforeEach(() => {
    setup = setupMyceliaTest();
    setEmailSender(setup.mockEmailSender);
    setMyceliaBlackboardAccessor(setup.mockBlackboard);
  });

  afterEach(() => {
    resetEmailSender();
    resetMyceliaFetcher();
    resetMyceliaBlackboardAccessor();
  });

  test('alerts when our request receives new responses', async () => {
    const responseBody = 'This looks great! Just a few minor suggestions...';
    const mockFetcher = createMockFetcher(
      [buildMyceliaRequest({ id: 'our-req-1', requester_id: 'test-agent-id', title: 'Our request', response_count: 1 })],
      85,
      {
        'our-req-1': buildMyceliaRequest({
          id: 'our-req-1',
          requester_id: 'test-agent-id',
          title: 'Our request',
          body: 'Please review this',
          response_count: 1,
          responses: [buildMyceliaResponse({ body: responseBody, confidence: 8 })],
        }),
      }
    );
    setMyceliaFetcher(mockFetcher);

    // Seed with response_count = 0
    setup.storedMetadata.seenRequestIds = [];
    setup.storedMetadata.responseCountsByRequestId = { 'our-req-1': 0 };

    const result = await evaluateMycelia(makeItem());

    expect(result.status).toBe('alert');
    expect(result.summary).toContain('1 new response');
    expect(setup.sentEmails).toHaveLength(1);
    expect(setup.sentEmails[0].subject).toContain('[Mycelia] 1 new response to: Our request');
    expect(setup.sentEmails[0].body).toContain('Helper Bot');
    expect(setup.sentEmails[0].body).toContain('Confidence: 8/10');
    expect(setup.sentEmails[0].body).toContain(responseBody);
  });

  test('does NOT alert when response count unchanged', async () => {
    const mockFetcher = createMockFetcher([
      buildMyceliaRequest({ id: 'our-req-1', requester_id: 'test-agent-id', title: 'Our request', response_count: 1 }),
    ]);
    setMyceliaFetcher(mockFetcher);

    // Seed with response_count = 1 (same as current)
    setup.storedMetadata.seenRequestIds = [];
    setup.storedMetadata.responseCountsByRequestId = { 'our-req-1': 1 };

    const result = await evaluateMycelia(makeItem());

    expect(result.status).toBe('ok');
    expectNoEmail(setup.sentEmails);
  });

  test('alerts with both new claimable requests AND new responses', async () => {
    const mockFetcher = createMockFetcher(
      [
        buildMyceliaRequest({ id: 'our-req-1', requester_id: 'test-agent-id', title: 'Our request', response_count: 1 }),
        buildMyceliaRequest({ id: 'req-2', title: 'New claimable request' }),
      ],
      85,
      {
        'our-req-1': buildMyceliaRequest({
          id: 'our-req-1',
          requester_id: 'test-agent-id',
          title: 'Our request',
          body: 'Please review this',
          response_count: 1,
          responses: [buildMyceliaResponse({ body: 'Looks good!', confidence: 9 })],
        }),
      }
    );
    setMyceliaFetcher(mockFetcher);

    // Seed with no previous data
    setup.storedMetadata.seenRequestIds = [];
    setup.storedMetadata.responseCountsByRequestId = { 'our-req-1': 0 };

    const result = await evaluateMycelia(makeItem());

    expect(result.status).toBe('alert');
    expect(result.summary).toContain('1 NEW request');

    // Should send 2 emails: one for response, one for claimable
    expect(setup.sentEmails).toHaveLength(2);
    expect(setup.sentEmails.some(e => e.subject.includes('new response'))).toBe(true);
    expect(setup.sentEmails.some(e => e.subject.includes('NEW request'))).toBe(true);
  });
});
