import type { TanaAccessor, TanaNode, TanaNodeContent } from './tana-types.ts';

// ─── Tana local API client (http://localhost:8262) ───────────────────────

/**
 * Default TanaAccessor that calls Tana Desktop's local REST API directly.
 *
 * Reads bearer token from ~/.config/supertag/config.json (same config
 * used by the supertag CLI). No subprocess spawning needed.
 *
 * In tests, this is entirely replaced by a mock via setTanaAccessor().
 */

const TANA_LOCAL_API = 'http://localhost:8262';
const CONFIG_PATH = `${process.env.HOME}/.config/supertag/config.json`;

let cachedBearerToken: string | null = null;

function getBearerToken(): string {
  if (cachedBearerToken) return cachedBearerToken;
  try {
    const fs = require('node:fs');
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);
    const token = config.localApi?.bearerToken ?? config.bearerToken ?? '';
    if (!token) throw new Error('No bearer token found in supertag config');
    cachedBearerToken = token;
    return token;
  } catch (err) {
    throw new Error(`Failed to read Tana bearer token from ${CONFIG_PATH}: ${(err as Error).message}`);
  }
}

/**
 * Serialize nested objects into bracket notation query params.
 * e.g. { and: [{ hasType: 'X' }] } → query[and][0][hasType]=X
 */
function serializeDeepObject(prefix: string, obj: unknown, out: Record<string, string>): void {
  if (obj === null || obj === undefined) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      serializeDeepObject(`${prefix}[${i}]`, obj[i], out);
    }
  } else if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      serializeDeepObject(`${prefix}[${key}]`, value, out);
    }
  } else {
    out[prefix] = String(obj);
  }
}

async function tanaGet(path: string, query?: Record<string, string>): Promise<unknown> {
  const url = new URL(path, TANA_LOCAL_API);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      url.searchParams.set(k, v);
    }
  }
  const resp = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${getBearerToken()}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Tana local API ${path} failed (${resp.status}): ${body.slice(0, 200)}`);
  }
  return resp.json();
}

async function tanaPost(path: string, body: unknown): Promise<unknown> {
  const resp = await fetch(`${TANA_LOCAL_API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getBearerToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Tana local API POST ${path} failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  return resp.json();
}

const defaultTanaAccessor: TanaAccessor = {
  async searchTodos(opts) {
    const query: Record<string, unknown> = {
      and: [
        { hasType: opts.tagId },
        { not: { is: 'done' } },
      ],
    };
    const params: Record<string, string> = {};
    serializeDeepObject('query', query, params);
    if (opts.limit) params.limit = String(opts.limit);

    const result = await tanaGet('/nodes/search', params);
    if (!Array.isArray(result)) return [];
    return result as TanaNode[];
  },

  async readNode(nodeId, maxDepth = 2) {
    const query: Record<string, string> = {};
    if (maxDepth !== undefined) query.maxDepth = String(maxDepth);

    const result = await tanaGet(`/nodes/${encodeURIComponent(nodeId)}`, query);
    if (!result || typeof result !== 'object') {
      return { id: nodeId, name: '', markdown: '', children: [] };
    }

    const r = result as Record<string, unknown>;
    return {
      id: nodeId,
      name: (r.name as string) ?? '',
      markdown: (r.markdown as string) ?? '',
      children: Array.isArray(r.children) ? r.children as string[] : [],
    };
  },

  async addChildContent(parentNodeId, content) {
    await tanaPost(`/nodes/${encodeURIComponent(parentNodeId)}/import`, { content });
  },

  async checkNode(nodeId) {
    await tanaPost(`/nodes/${encodeURIComponent(nodeId)}/done`, { done: true });
  },
};

// ─── Injectable accessor (for testing) ────────────────────────────────────

let tanaAccessor: TanaAccessor = defaultTanaAccessor;

export function getTanaAccessor(): TanaAccessor {
  return tanaAccessor;
}

export function setTanaAccessor(accessor: TanaAccessor): void {
  tanaAccessor = accessor;
}

export function resetTanaAccessor(): void {
  tanaAccessor = defaultTanaAccessor;
}
