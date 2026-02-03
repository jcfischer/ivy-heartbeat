import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, cleanupTestContext, type TestContext } from './helpers.ts';
import { listAgents } from 'ivy-blackboard/src/agent';

/**
 * CLI tests exercise the Blackboard class methods that the CLI commands delegate to.
 * This validates the same code paths without spawning subprocesses.
 */

let ctx: TestContext;

describe('CLI: agent register', () => {
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => { cleanupTestContext(ctx); });

  test('register returns session_id as UUID', () => {
    const result = ctx.bb.registerAgent({ name: 'CliTest' });
    expect(result.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.agent_name).toBe('CliTest');
    expect(result.status).toBe('active');
  });

  test('register with all options', () => {
    const result = ctx.bb.registerAgent({
      name: 'FullAgent',
      project: 'ivy-heartbeat',
      work: 'Running checks',
    });
    expect(result.project).toBe('ivy-heartbeat');
    expect(result.current_work).toBe('Running checks');
    expect(result.pid).toBe(process.pid);
  });

  test('register with parent (delegate)', () => {
    const parent = ctx.bb.registerAgent({ name: 'Parent' });
    const delegate = ctx.bb.registerAgent({
      name: 'Delegate',
      parentId: parent.session_id,
    });
    expect(delegate.parent_id).toBe(parent.session_id);
  });
});

describe('CLI: agent heartbeat', () => {
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => { cleanupTestContext(ctx); });

  test('heartbeat with progress', () => {
    const agent = ctx.bb.registerAgent({ name: 'HBAgent' });
    const result = ctx.bb.sendHeartbeat({
      sessionId: agent.session_id,
      progress: 'Checked 5 items',
    });
    expect(result.progress).toBe('Checked 5 items');
    expect(result.timestamp).toBeTruthy();
  });

  test('heartbeat without progress', () => {
    const agent = ctx.bb.registerAgent({ name: 'SilentHB' });
    const result = ctx.bb.sendHeartbeat({ sessionId: agent.session_id });
    expect(result.progress).toBeNull();
  });

  test('heartbeat for unknown session throws', () => {
    expect(() => {
      ctx.bb.sendHeartbeat({ sessionId: 'nonexistent-session-id' });
    }).toThrow(/Agent session not found/);
  });
});

describe('CLI: agent deregister', () => {
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => { cleanupTestContext(ctx); });

  test('deregister completes session', () => {
    const agent = ctx.bb.registerAgent({ name: 'DeregTest' });
    const result = ctx.bb.deregisterAgent(agent.session_id);
    expect(result.agent_name).toBe('DeregTest');
    expect(result.released_count).toBe(0);
    expect(result.duration_seconds).toBeGreaterThanOrEqual(0);
  });

  test('deregister for unknown session throws', () => {
    expect(() => {
      ctx.bb.deregisterAgent('nonexistent-session-id');
    }).toThrow(/Agent session not found/);
  });

  test('deregistered agent shows as completed', () => {
    const agent = ctx.bb.registerAgent({ name: 'CompletedTest' });
    ctx.bb.deregisterAgent(agent.session_id);

    const agents = listAgents(ctx.bb.db, { all: true });
    const found = agents.find(a => a.session_id === agent.session_id);
    expect(found).toBeDefined();
    expect(found!.status).toBe('completed');
  });
});

describe('CLI: agent list', () => {
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => { cleanupTestContext(ctx); });

  test('list returns active agents', () => {
    ctx.bb.registerAgent({ name: 'Active1' });
    ctx.bb.registerAgent({ name: 'Active2' });
    const agents = listAgents(ctx.bb.db);
    expect(agents.length).toBe(2);
    expect(agents.every(a => a.status === 'active')).toBe(true);
  });

  test('list excludes completed agents by default', () => {
    const a1 = ctx.bb.registerAgent({ name: 'Running' });
    const a2 = ctx.bb.registerAgent({ name: 'Done' });
    ctx.bb.deregisterAgent(a2.session_id);

    const active = listAgents(ctx.bb.db);
    expect(active.length).toBe(1);
    expect(active[0].agent_name).toBe('Running');
  });

  test('list --all includes completed', () => {
    const a1 = ctx.bb.registerAgent({ name: 'Running' });
    const a2 = ctx.bb.registerAgent({ name: 'Done' });
    ctx.bb.deregisterAgent(a2.session_id);

    const all = listAgents(ctx.bb.db, { all: true });
    expect(all.length).toBe(2);
  });

  test('list --status filter', () => {
    ctx.bb.registerAgent({ name: 'ActiveAgent' });
    const done = ctx.bb.registerAgent({ name: 'CompletedAgent' });
    ctx.bb.deregisterAgent(done.session_id);

    const completed = listAgents(ctx.bb.db, { status: 'completed' });
    expect(completed.length).toBe(1);
    expect(completed[0].agent_name).toBe('CompletedAgent');
  });

  test('empty list', () => {
    const agents = listAgents(ctx.bb.db);
    expect(agents.length).toBe(0);
  });
});

describe('CLI: observe events', () => {
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => { cleanupTestContext(ctx); });

  test('observe events shows recent events', () => {
    const agent = ctx.bb.registerAgent({ name: 'ObsAgent' });
    ctx.bb.appendEvent({ actorId: agent.session_id, summary: 'Check complete' });

    const events = ctx.bb.eventQueries.getRecent(20);
    expect(events.length).toBeGreaterThanOrEqual(2); // agent_registered + appended
  });

  test('observe events with type filter', () => {
    ctx.bb.registerAgent({ name: 'TypeFilter' });
    ctx.bb.appendEvent({ summary: 'HB event' });

    const hbEvents = ctx.bb.eventQueries.getByType('heartbeat_received');
    expect(hbEvents.length).toBe(1);
    expect(hbEvents[0].summary).toBe('HB event');

    const regEvents = ctx.bb.eventQueries.getByType('agent_registered');
    expect(regEvents.length).toBe(1);
  });
});

describe('CLI: observe heartbeats', () => {
  beforeEach(() => { ctx = createTestContext(); });
  afterEach(() => { cleanupTestContext(ctx); });

  test('observe heartbeats shows recent', () => {
    const agent = ctx.bb.registerAgent({ name: 'HBObs' });
    ctx.bb.sendHeartbeat({ sessionId: agent.session_id, progress: 'Beat 1' });
    ctx.bb.sendHeartbeat({ sessionId: agent.session_id, progress: 'Beat 2' });

    const hbs = ctx.bb.heartbeatQueries.getRecent(20);
    expect(hbs.length).toBe(2);
  });

  test('observe heartbeats with session filter', () => {
    const a1 = ctx.bb.registerAgent({ name: 'Agent1' });
    const a2 = ctx.bb.registerAgent({ name: 'Agent2' });
    ctx.bb.sendHeartbeat({ sessionId: a1.session_id, progress: 'A1 beat' });
    ctx.bb.sendHeartbeat({ sessionId: a2.session_id, progress: 'A2 beat' });

    const a1Beats = ctx.bb.heartbeatQueries.getBySession(a1.session_id);
    expect(a1Beats.length).toBe(1);
    expect(a1Beats[0].progress).toBe('A1 beat');
  });
});
