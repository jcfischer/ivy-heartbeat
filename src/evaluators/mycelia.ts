import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

interface MyceliaConfig {
  clientPath: string;
  agentId: string;
  capabilities: string[];
  emailTo: string | null;
}

interface MyceliaRequest {
  id: string;
  requester_id: string;
  title: string;
  request_type: string;
  status: string;
  response_count: number;
  max_responses: number;
  created_at: string;
  expires_at: string;
}

interface MyceliaResponse {
  id: string;
  responder_id: string;
  responder_name: string;
  body: string;
  confidence: number;
  created_at: string;
}

interface MyceliaRequestDetail {
  id: string;
  requester_id: string;
  title: string;
  body: string;
  request_type: string;
  status: string;
  response_count: number;
  max_responses: number;
  created_at: string;
  expires_at: string;
  responses: MyceliaResponse[];
}

interface MyceliaApiResponse {
  ok: boolean;
  data?: {
    requests?: MyceliaRequest[];
    request?: MyceliaRequestDetail;
    agent?: { trust_score: number; request_count: number; response_count: number };
  };
}

export type MyceliaBlackboardAccessor = {
  findLastEventByCheckName(checkName: string): { metadata: string | null } | null;
  appendEvent(opts: {
    summary: string;
    metadata?: Record<string, unknown>;
  }): void;
};

// ─── Injectable API fetcher (for testing) ──────────────────────────────────

export type MyceliaApiFetcher = (path: string, configPath: string) => Promise<MyceliaApiResponse | null>;

let apiFetcher: MyceliaApiFetcher = defaultApiFetcher;

/**
 * Fetch from Mycelia API directly using the config file.
 */
async function defaultApiFetcher(path: string, configPath: string): Promise<MyceliaApiResponse | null> {
  try {
    const configFile = Bun.file(configPath);
    if (!await configFile.exists()) return null;

    const config = JSON.parse(await configFile.text());
    const res = await fetch(`${config.base_url}${path}`, {
      headers: { Authorization: `Bearer ${config.api_key}` },
    });

    if (!res.ok) return null;
    return await res.json() as MyceliaApiResponse;
  } catch {
    return null;
  }
}

async function fetchMyceliaApi(path: string, configPath: string): Promise<MyceliaApiResponse | null> {
  return apiFetcher(path, configPath);
}

export function setMyceliaFetcher(fetcher: MyceliaApiFetcher): void {
  apiFetcher = fetcher;
}

export function resetMyceliaFetcher(): void {
  apiFetcher = defaultApiFetcher;
}

// ─── Email notification ─────────────────────────────────────────────────────

export type EmailSender = (to: string, subject: string, body: string) => Promise<boolean>;

let emailSender: EmailSender = defaultEmailSender;

async function defaultEmailSender(to: string, subject: string, body: string): Promise<boolean> {
  try {
    const emailSkillDir = `${process.env.HOME}/.claude/skills/Productivity/email`;
    const proc = Bun.spawn(
      ['bun', 'run', 'src/index.ts', 'send', '-t', to, '-s', subject, '-b', body],
      { cwd: emailSkillDir, stdout: 'pipe', stderr: 'pipe' }
    );
    await proc.exited;
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

export function setEmailSender(sender: EmailSender): void {
  emailSender = sender;
}

export function resetEmailSender(): void {
  emailSender = defaultEmailSender;
}

// ─── Blackboard accessor ─────────────────────────────────────────────────

let bbAccessor: MyceliaBlackboardAccessor | null = null;

export function setMyceliaBlackboardAccessor(accessor: MyceliaBlackboardAccessor): void {
  bbAccessor = accessor;
}

export function resetMyceliaBlackboardAccessor(): void {
  bbAccessor = null;
}

// ─── Config parsing ─────────────────────────────────────────────────────────

function parseMyceliaConfig(item: ChecklistItem): MyceliaConfig | null {
  const configPath = (item.config.config_path as string) ??
    `${process.env.HOME}/.config/mycelia/agent-config.json`;

  const agentId = (item.config.agent_id as string) ?? '';

  const capabilitiesRaw = (item.config.capabilities as string) ?? '';
  const capabilities = capabilitiesRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const emailTo = (item.config.email_to as string) ?? null;

  return { clientPath: configPath, agentId, capabilities, emailTo };
}

// ─── Evaluator ──────────────────────────────────────────────────────────────

export async function evaluateMycelia(item: ChecklistItem): Promise<CheckResult> {
  const config = parseMyceliaConfig(item);

  if (!config) {
    return {
      item,
      status: 'ok',
      summary: `Mycelia: ${item.name} (not configured — skipped)`,
      details: { configured: false },
    };
  }

  try {
    // Fetch open requests
    const requestsData = await fetchMyceliaApi('/v1/requests', config.clientPath);

    if (!requestsData?.ok) {
      return {
        item,
        status: 'error',
        summary: `Mycelia: ${item.name} — API unreachable or auth failed`,
        details: { configured: true, error: 'API call failed' },
      };
    }

    const requests = requestsData.data?.requests ?? [];

    // Filter out our own requests — only show requests from other agents
    const claimable = requests.filter((r) =>
      r.status === 'open' &&
      r.response_count < r.max_responses &&
      r.requester_id !== config.agentId
    );

    // Fetch our profile for trust score monitoring
    let trustScore: number | null = null;
    if (config.agentId) {
      const profileData = await fetchMyceliaApi(`/v1/agents/${config.agentId}`, config.clientPath);
      if (profileData?.ok && profileData.data?.agent) {
        trustScore = profileData.data.agent.trust_score;
      }
    }

    // Load previous state from blackboard (if available)
    let previousSeenIds: string[] = [];
    let previousResponseCounts: Record<string, number> = {};

    if (bbAccessor) {
      const lastEvent = bbAccessor.findLastEventByCheckName(item.name);
      if (lastEvent?.metadata) {
        try {
          const metadata = JSON.parse(lastEvent.metadata);
          previousSeenIds = metadata.seenRequestIds ?? [];
          previousResponseCounts = metadata.responseCountsByRequestId ?? {};
        } catch {
          // Ignore parse errors
        }
      }
    }

    // Deduplicate claimable requests — only alert on new ones
    const currentIds = claimable.map((r) => r.id);
    const newRequests = claimable.filter((r) => !previousSeenIds.includes(r.id));
    const newCount = newRequests.length;

    // Check our own requests for new responses
    const ourRequests = requests.filter((r) => r.requester_id === config.agentId);
    const newResponses: Array<{ request: MyceliaRequestDetail; newResponseCount: number }> = [];

    for (const req of ourRequests) {
      const previousCount = previousResponseCounts[req.id] ?? 0;
      if (req.response_count > previousCount) {
        // Fetch full request details to get response bodies
        const detailData = await fetchMyceliaApi(`/v1/requests/${req.id}`, config.clientPath);
        if (detailData?.ok && detailData.data?.request) {
          newResponses.push({
            request: detailData.data.request,
            newResponseCount: req.response_count - previousCount,
          });
        }
      }
    }

    // Update response count tracking
    const updatedResponseCounts: Record<string, number> = {};
    for (const req of ourRequests) {
      updatedResponseCounts[req.id] = req.response_count;
    }

    // Save state to blackboard for next check
    if (bbAccessor) {
      bbAccessor.appendEvent({
        summary: `Mycelia check: ${newCount} new claimable, ${newResponses.length} new responses`,
        metadata: {
          checkName: item.name,
          seenRequestIds: currentIds,
          responseCountsByRequestId: updatedResponseCounts,
          newClaimableCount: newCount,
          newResponseCount: newResponses.length,
        },
      });
    }

    // Handle new responses first
    if (newResponses.length > 0 && config.emailTo) {
      for (const { request, newResponseCount } of newResponses) {
        const emailSubject = `[Mycelia] ${newResponseCount} new response${newResponseCount > 1 ? 's' : ''} to: ${request.title}`;

        const responseSections = request.responses.slice(-newResponseCount).map((resp) => {
          return [
            `From: ${resp.responder_name}`,
            `Confidence: ${resp.confidence}/10`,
            ``,
            resp.body,
            ``,
            `---`,
          ].join('\n');
        });

        const emailBody = [
          `Your request "${request.title}" received ${newResponseCount} new response${newResponseCount > 1 ? 's' : ''}:\n`,
          ...responseSections,
          '',
          `To rate responses, tell Ivy: "mycelia rate [RESPONSE_ID]"`,
          `View full request: https://mycelia.fyi/requests/${request.id}`,
        ].join('\n');

        await emailSender(config.emailTo, emailSubject, emailBody);
      }
    }

    // Handle new claimable requests
    if (newCount > 0) {
      const summary = `Mycelia: ${newCount} NEW request${newCount > 1 ? 's' : ''} available to claim`;

      const newTitles = newRequests.map((r) =>
        `• ${r.title} (${r.request_type}, ${r.response_count}/${r.max_responses} responses)`
      );

      // Send email notification if configured
      if (config.emailTo) {
        const emailSubject = `[Mycelia] ${newCount} NEW request${newCount > 1 ? 's' : ''} available`;
        const emailBody = [
          `${newCount} new request${newCount > 1 ? 's' : ''} on the Mycelia network:\n`,
          ...newTitles,
          '',
          'To claim, tell Ivy: "check mycelia" or "mycelia browse"',
        ].join('\n');

        await emailSender(config.emailTo, emailSubject, emailBody);
      }

      return {
        item,
        status: 'alert',
        summary,
        details: {
          configured: true,
          claimableCount: claimable.length,
          newClaimableCount: newCount,
          newClaimable: newTitles,
          newResponseCount: newResponses.length,
          trustScore,
        },
      };
    }

    // No new claimable requests, but check for new responses
    if (newResponses.length > 0) {
      return {
        item,
        status: 'alert',
        summary: `Mycelia: ${newResponses.length} new response${newResponses.length > 1 ? 's' : ''} to your requests`,
        details: {
          configured: true,
          claimableCount: claimable.length,
          newClaimableCount: 0,
          newResponseCount: newResponses.length,
          trustScore,
        },
      };
    }

    return {
      item,
      status: 'ok',
      summary: `Mycelia: no new activity. Trust: ${trustScore ?? 'unknown'}`,
      details: {
        configured: true,
        claimableCount: claimable.length,
        newClaimableCount: 0,
        newResponseCount: 0,
        trustScore,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `Mycelia: ${item.name} — Error: ${msg}`,
      details: { configured: true, error: msg },
    };
  }
}
