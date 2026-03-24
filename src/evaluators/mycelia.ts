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

interface MyceliaApiResponse {
  ok: boolean;
  data?: {
    requests?: MyceliaRequest[];
    agent?: { trust_score: number; request_count: number; response_count: number };
  };
}

// ─── Injectable fetcher (for testing) ───────────────────────────────────────

export type MyceliaFetcher = (command: string[]) => Promise<MyceliaApiResponse | null>;

let myceliaFetcher: MyceliaFetcher = defaultMyceliaFetcher;

async function defaultMyceliaFetcher(command: string[]): Promise<MyceliaApiResponse | null> {
  try {
    const proc = Bun.spawn(['bun', 'run', ...command], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode !== 0) return null;

    // The CLI outputs formatted text, not JSON. Use the API directly.
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetch from Mycelia API directly using the config file.
 */
async function fetchMyceliaApi(path: string, configPath: string): Promise<MyceliaApiResponse | null> {
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

export function setMyceliaFetcher(fetcher: MyceliaFetcher): void {
  myceliaFetcher = fetcher;
}

export function resetMyceliaFetcher(): void {
  myceliaFetcher = defaultMyceliaFetcher;
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

    // Build alert details
    const claimableCount = claimable.length;
    const claimableTitles = claimable.map((r) =>
      `• ${r.title} (${r.request_type}, ${r.response_count}/${r.max_responses} responses)`
    );

    if (claimableCount > 0) {
      const summary = `Mycelia: ${claimableCount} open request${claimableCount > 1 ? 's' : ''} available to claim`;

      // Send email notification if configured
      if (config.emailTo) {
        const emailSubject = `[Mycelia] ${claimableCount} request${claimableCount > 1 ? 's' : ''} available`;
        const emailBody = [
          `${claimableCount} open request${claimableCount > 1 ? 's' : ''} on the Mycelia network:\n`,
          ...claimableTitles,
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
          claimableCount,
          claimable: claimableTitles,
          trustScore,
        },
      };
    }

    return {
      item,
      status: 'ok',
      summary: `Mycelia: no claimable requests. Trust: ${trustScore ?? 'unknown'}`,
      details: {
        configured: true,
        claimableCount: 0,
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
