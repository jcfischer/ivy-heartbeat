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

describe('Mycelia evaluator - deduplication', () => {
  let sentEmails: Array<{ to: string; subject: string; body: string }> = [];
  let appendedEvents: Array<{ summary: string; metadata?: Record<string, unknown> }> = [];
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

  beforeEach(() => {
    sentEmails = [];
    appendedEvents = [];
    storedMetadata = {};
    setEmailSender(mockEmailSender);
    setMyceliaBlackboardAccessor(mockBlackboard);
  });

  afterEach(() => {
    resetEmailSender();
    resetMyceliaFetcher();
    resetMyceliaBlackboardAccessor();
  });

  test('alerts on first run with claimable requests', async () => {
    const mockFetcher: MyceliaApiFetcher = async (path, _configPath) => {
      if (path === '/v1/requests') {
        return {
          ok: true,
          data: {
            requests: [
              {
                id: 'req-1',
                requester_id: 'other-agent',
                title: 'Help needed',
                request_type: 'review',
                status: 'open',
                response_count: 0,
                max_responses: 3,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
              },
            ],
          },
        };
      }
      if (path === '/v1/agents/test-agent-id') {
        return {
          ok: true,
          data: { agent: { trust_score: 85, request_count: 5, response_count: 10 } },
        };
      }
      return null;
    };

    setMyceliaFetcher(mockFetcher);

    const result = await evaluateMycelia(makeItem());

    expect(result.status).toBe('alert');
    expect(result.summary).toContain('1 NEW request');
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].subject).toContain('[Mycelia] 1 NEW request available');
    expect(sentEmails[0].body).toContain('Help needed');

    // Verify metadata stored
    expect(appendedEvents).toHaveLength(1);
    expect(appendedEvents[0].metadata?.seenRequestIds).toEqual(['req-1']);
  });

  test('does NOT alert on second run with same requests', async () => {
    const mockFetcher: MyceliaApiFetcher = async (path, _configPath) => {
      if (path === '/v1/requests') {
        return {
          ok: true,
          data: {
            requests: [
              {
                id: 'req-1',
                requester_id: 'other-agent',
                title: 'Help needed',
                request_type: 'review',
                status: 'open',
                response_count: 0,
                max_responses: 3,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
              },
            ],
          },
        };
      }
      if (path === '/v1/agents/test-agent-id') {
        return {
          ok: true,
          data: { agent: { trust_score: 85, request_count: 5, response_count: 10 } },
        };
      }
      return null;
    };

    setMyceliaFetcher(mockFetcher);

    // First run
    await evaluateMycelia(makeItem());
    sentEmails = [];
    appendedEvents = [];

    // Second run with same request
    const result = await evaluateMycelia(makeItem());

    expect(result.status).toBe('ok');
    expect(result.summary).toContain('no new activity');
    expect(sentEmails).toHaveLength(0);
  });

  test('alerts only on NEW requests when some are already seen', async () => {
    const mockFetcher: MyceliaApiFetcher = async (path, _configPath) => {
      if (path === '/v1/requests') {
        return {
          ok: true,
          data: {
            requests: [
              {
                id: 'req-1',
                requester_id: 'other-agent',
                title: 'Old request',
                request_type: 'review',
                status: 'open',
                response_count: 0,
                max_responses: 3,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
              },
              {
                id: 'req-2',
                requester_id: 'other-agent',
                title: 'New request',
                request_type: 'review',
                status: 'open',
                response_count: 0,
                max_responses: 3,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
              },
            ],
          },
        };
      }
      if (path === '/v1/agents/test-agent-id') {
        return {
          ok: true,
          data: { agent: { trust_score: 85, request_count: 5, response_count: 10 } },
        };
      }
      return null;
    };

    setMyceliaFetcher(mockFetcher);

    // Seed with req-1 already seen
    storedMetadata = {
      seenRequestIds: ['req-1'],
      responseCountsByRequestId: {},
    };

    const result = await evaluateMycelia(makeItem());

    expect(result.status).toBe('alert');
    expect(result.summary).toContain('1 NEW request');
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].body).toContain('New request');
    expect(sentEmails[0].body).not.toContain('Old request');
  });
});

describe('Mycelia evaluator - response tracking', () => {
  let sentEmails: Array<{ to: string; subject: string; body: string }> = [];
  let appendedEvents: Array<{ summary: string; metadata?: Record<string, unknown> }> = [];
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

  beforeEach(() => {
    sentEmails = [];
    appendedEvents = [];
    storedMetadata = {};
    setEmailSender(mockEmailSender);
    setMyceliaBlackboardAccessor(mockBlackboard);
  });

  afterEach(() => {
    resetEmailSender();
    resetMyceliaFetcher();
    resetMyceliaBlackboardAccessor();
  });

  test('alerts when our request receives new responses', async () => {
    const mockFetcher: MyceliaFetcher = async (path) => {
      if (path === '/v1/requests/our-req-1') {
        return {
          ok: true,
          data: {
            request: {
              id: 'our-req-1',
              requester_id: 'test-agent-id',
              title: 'Our request',
              body: 'Please review this',
              request_type: 'review',
              status: 'open',
              response_count: 1,
              max_responses: 3,
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 86400000).toISOString(),
              responses: [
                {
                  id: 'resp-1',
                  responder_id: 'helper-agent',
                  responder_name: 'Helper Bot',
                  body: 'This looks great! Just a few minor suggestions...',
                  confidence: 8,
                  created_at: new Date().toISOString(),
                },
              ],
            },
          },
        };
      }
      if (path === '/v1/requests') {
        return {
          ok: true,
          data: {
            requests: [
              {
                id: 'our-req-1',
                requester_id: 'test-agent-id',
                title: 'Our request',
                request_type: 'review',
                status: 'open',
                response_count: 1,
                max_responses: 3,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
              },
            ],
          },
        };
      }
      if (path === '/v1/agents/test-agent-id') {
        return {
          ok: true,
          data: { agent: { trust_score: 85, request_count: 5, response_count: 10 } },
        };
      }
      return null;
    };

    setMyceliaFetcher(mockFetcher);

    // Seed with response_count = 0
    storedMetadata = {
      seenRequestIds: [],
      responseCountsByRequestId: { 'our-req-1': 0 },
    };

    const result = await evaluateMycelia(makeItem());

    expect(result.status).toBe('alert');
    expect(result.summary).toContain('1 new response');
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].subject).toContain('[Mycelia] 1 new response to: Our request');
    expect(sentEmails[0].body).toContain('Helper Bot');
    expect(sentEmails[0].body).toContain('Confidence: 8/10');
    expect(sentEmails[0].body).toContain('This looks great! Just a few minor suggestions...');
  });

  test('does NOT alert when response count unchanged', async () => {
    const mockFetcher: MyceliaApiFetcher = async (path, _configPath) => {
      if (path === '/v1/requests') {
        return {
          ok: true,
          data: {
            requests: [
              {
                id: 'our-req-1',
                requester_id: 'test-agent-id',
                title: 'Our request',
                request_type: 'review',
                status: 'open',
                response_count: 1,
                max_responses: 3,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
              },
            ],
          },
        };
      }
      if (path === '/v1/agents/test-agent-id') {
        return {
          ok: true,
          data: { agent: { trust_score: 85, request_count: 5, response_count: 10 } },
        };
      }
      return null;
    };

    setMyceliaFetcher(mockFetcher);

    // Seed with response_count = 1 (same as current)
    storedMetadata = {
      seenRequestIds: [],
      responseCountsByRequestId: { 'our-req-1': 1 },
    };

    const result = await evaluateMycelia(makeItem());

    expect(result.status).toBe('ok');
    expect(sentEmails).toHaveLength(0);
  });

  test('alerts with both new claimable requests AND new responses', async () => {
    const mockFetcher: MyceliaFetcher = async (path) => {
      if (path === '/v1/requests/our-req-1') {
        return {
          ok: true,
          data: {
            request: {
              id: 'our-req-1',
              requester_id: 'test-agent-id',
              title: 'Our request',
              body: 'Please review this',
              request_type: 'review',
              status: 'open',
              response_count: 1,
              max_responses: 3,
              created_at: new Date().toISOString(),
              expires_at: new Date(Date.now() + 86400000).toISOString(),
              responses: [
                {
                  id: 'resp-1',
                  responder_id: 'helper-agent',
                  responder_name: 'Helper Bot',
                  body: 'Looks good!',
                  confidence: 9,
                  created_at: new Date().toISOString(),
                },
              ],
            },
          },
        };
      }
      if (path === '/v1/requests') {
        return {
          ok: true,
          data: {
            requests: [
              {
                id: 'our-req-1',
                requester_id: 'test-agent-id',
                title: 'Our request',
                request_type: 'review',
                status: 'open',
                response_count: 1,
                max_responses: 3,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
              },
              {
                id: 'req-2',
                requester_id: 'other-agent',
                title: 'New claimable request',
                request_type: 'review',
                status: 'open',
                response_count: 0,
                max_responses: 3,
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
              },
            ],
          },
        };
      }
      if (path === '/v1/agents/test-agent-id') {
        return {
          ok: true,
          data: { agent: { trust_score: 85, request_count: 5, response_count: 10 } },
        };
      }
      return null;
    };

    setMyceliaFetcher(mockFetcher);

    // Seed with no previous data
    storedMetadata = {
      seenRequestIds: [],
      responseCountsByRequestId: { 'our-req-1': 0 },
    };

    const result = await evaluateMycelia(makeItem());

    expect(result.status).toBe('alert');
    expect(result.summary).toContain('1 NEW request');

    // Should send 2 emails: one for response, one for claimable
    expect(sentEmails).toHaveLength(2);
    expect(sentEmails.some(e => e.subject.includes('new response'))).toBe(true);
    expect(sentEmails.some(e => e.subject.includes('NEW request'))).toBe(true);
  });
});
