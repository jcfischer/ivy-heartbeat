import type { Blackboard } from '../blackboard.ts';
import { generateSummary } from '../observe/summary.ts';
import { generateDashboardHTML } from './dashboard.ts';
import { getSpecFlowPipelines } from './api/specflow-pipeline.ts';
import { renderSpecFlowPanel } from './views/specflow-panel.ts';

export interface ServerOptions {
  port: number;
  hostname: string;
}

const DEFAULT_OPTIONS: ServerOptions = {
  port: 7878,
  hostname: '127.0.0.1',
};

/**
 * Create and start the Ivy Heartbeat web dashboard server.
 * Returns the Bun server instance for lifecycle management.
 */
export function startServer(bb: Blackboard, opts: Partial<ServerOptions> = {}) {
  const { port, hostname } = { ...DEFAULT_OPTIONS, ...opts };
  const dashboardHTML = generateDashboardHTML();

  const server = Bun.serve({
    port,
    hostname,
    fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS headers for local development
      const headers = {
        'Access-Control-Allow-Origin': `http://localhost:${port}`,
        'Content-Type': 'application/json',
      };

      try {
        // Dashboard HTML
        if (path === '/' || path === '/index.html') {
          return new Response(dashboardHTML, {
            headers: { 'Content-Type': 'text/html' },
          });
        }

        // API: Events
        if (path === '/api/events') {
          const limit = parseInt(url.searchParams.get('limit') ?? '30', 10);
          const since = url.searchParams.get('since');
          const events = since
            ? bb.eventQueries.getSince(since).slice(0, limit)
            : bb.eventQueries.getRecent(limit);
          return Response.json(events, { headers });
        }

        // API: Heartbeats
        if (path === '/api/heartbeats') {
          const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
          const heartbeats = bb.heartbeatQueries.getRecent(limit);
          return Response.json(heartbeats, { headers });
        }

        // API: Summary
        if (path === '/api/summary') {
          const summary = generateSummary(bb);
          return Response.json(summary, { headers });
        }

        // API: SpecFlow Pipelines
        if (path === '/api/specflow/pipelines') {
          const pipelines = getSpecFlowPipelines(bb);
          return Response.json(pipelines, { headers });
        }

        // API: SpecFlow Pipeline Panel HTML
        if (path === '/api/specflow/panel') {
          const pipelines = getSpecFlowPipelines(bb);
          const html = renderSpecFlowPanel(pipelines);
          return new Response(html, {
            headers: { ...headers, 'Content-Type': 'text/html' },
          });
        }

        // API: Search
        if (path === '/api/search') {
          const query = url.searchParams.get('q') ?? '';
          if (!query) {
            return Response.json([], { headers });
          }
          const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
          const results = bb.eventQueries.search(query, { limit });
          return Response.json(results, { headers });
        }

        // 404
        return Response.json(
          { error: 'Not found' },
          { status: 404, headers }
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json(
          { error: msg },
          { status: 500, headers }
        );
      }
    },
  });

  return server;
}
