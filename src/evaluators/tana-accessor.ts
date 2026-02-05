import type { TanaAccessor, TanaNode, TanaNodeContent } from './tana-types.ts';

// ─── Default TanaAccessor implementation (MCP stdio subprocess) ───────────

/**
 * Default TanaAccessor that calls tana-local MCP tools via Bun.spawn.
 *
 * The heartbeat runs as a standalone CLI process, so it cannot call
 * MCP tools directly. This implementation shells out to the tana-local
 * MCP helper, similar to how github-issues uses `gh` CLI.
 *
 * In tests, this is entirely replaced by a mock via setTanaAccessor().
 */
async function mcpCall(tool: string, params: Record<string, unknown>): Promise<unknown> {
  const input = JSON.stringify({ tool, params });

  const proc = Bun.spawn(
    ['bun', 'run', '--silent', new URL('./tana-mcp-client.ts', import.meta.url).pathname, '--'],
    {
      stdin: new Blob([input]),
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );

  const timeoutId = setTimeout(() => proc.kill(), 10_000);

  try {
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timeoutId);

    if (proc.exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`tana-local MCP call failed (exit ${proc.exitCode}): ${stderr.slice(0, 200)}`);
    }

    return JSON.parse(output);
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof SyntaxError) {
      throw new Error('tana-local MCP server returned invalid JSON');
    }
    throw err;
  }
}

const defaultTanaAccessor: TanaAccessor = {
  async searchTodos(opts) {
    const result = await mcpCall('search_nodes', {
      query: {
        and: [
          { hasType: opts.tagId },
          { not: { is: 'done' } },
        ],
      },
      workspaceIds: opts.workspaceId ? [opts.workspaceId] : undefined,
      limit: opts.limit ?? 20,
    });

    // search_nodes returns an array of nodes
    if (!Array.isArray(result)) return [];
    return result as TanaNode[];
  },

  async readNode(nodeId, maxDepth = 2) {
    const result = await mcpCall('read_node', {
      nodeId,
      maxDepth,
    });

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
    await mcpCall('import_tana_paste', {
      parentNodeId,
      content,
    });
  },

  async checkNode(nodeId) {
    await mcpCall('check_node', { nodeId });
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
