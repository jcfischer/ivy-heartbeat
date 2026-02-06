import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Blackboard } from '../src/blackboard.ts';
import { startServer } from '../src/serve/server.ts';
import { generateDashboardHTML } from '../src/serve/dashboard.ts';

describe('web dashboard server', () => {
  let bb: Blackboard;
  let tmpDir: string;
  let server: ReturnType<typeof startServer>;
  let baseUrl: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hb-serve-'));
    bb = new Blackboard(join(tmpDir, 'test.db'));
    // Use random high port to avoid conflicts
    const port = 10000 + Math.floor(Math.random() * 50000);
    server = startServer(bb, { port });
    baseUrl = `http://localhost:${server.port}`;
  });

  afterEach(() => {
    server.stop();
    bb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('GET / returns HTML dashboard', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Ivy Heartbeat Dashboard');
  });

  test('GET /api/events returns JSON array', async () => {
    bb.appendEvent({ summary: 'Test event' });

    const res = await fetch(`${baseUrl}/api/events`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].summary).toContain('Test event');
  });

  test('GET /api/events respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      bb.appendEvent({ summary: `Event ${i}` });
    }

    const res = await fetch(`${baseUrl}/api/events?limit=3`);
    const data = await res.json();
    expect(data.length).toBe(3);
  });

  test('GET /api/heartbeats returns JSON array', async () => {
    const agent = bb.registerAgent({ name: 'test' });
    bb.sendHeartbeat({ sessionId: agent.session_id, progress: 'Working' });

    const res = await fetch(`${baseUrl}/api/heartbeats`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
  });

  test('GET /api/summary returns summary object', async () => {
    bb.appendEvent({ summary: 'Check done', metadata: { checkName: 'Test', status: 'ok' } });

    const res = await fetch(`${baseUrl}/api/summary`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.totalEvents).toBe('number');
    expect(typeof data.activeAgents).toBe('number');
    expect(Array.isArray(data.recentChecks)).toBe(true);
  });

  test('GET /api/search returns results for matching query', async () => {
    bb.appendEvent({ summary: 'Calendar conflict detected' });

    const res = await fetch(`${baseUrl}/api/search?q=calendar`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThanOrEqual(1);
    expect(data[0].event.summary).toContain('Calendar');
  });

  test('GET /api/search returns empty for no query', async () => {
    const res = await fetch(`${baseUrl}/api/search`);
    const data = await res.json();
    expect(data).toEqual([]);
  });

  test('GET /unknown returns 404', async () => {
    const res = await fetch(`${baseUrl}/unknown`);
    expect(res.status).toBe(404);
  });

  test('CORS header restricts origin to localhost with server port', async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    const origin = res.headers.get('access-control-allow-origin');
    expect(origin).toBe(`http://localhost:${server.port}`);
    expect(origin).not.toBe('*');
  });
});

describe('dashboard HTML', () => {
  test('generates valid HTML with required elements', () => {
    const html = generateDashboardHTML();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Ivy Heartbeat Dashboard');
    expect(html).toContain('/api/events');
    expect(html).toContain('/api/summary');
    expect(html).toContain('/api/search');
    expect(html).toContain('search-input');
  });
});
