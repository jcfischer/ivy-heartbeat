import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, cleanupTestContext, type TestContext } from './helpers.ts';

let ctx: TestContext;

describe('HeartbeatQueryRepository', () => {
  let sessionId: string;

  beforeEach(() => {
    ctx = createTestContext();
    const agent = ctx.bb.registerAgent({ name: 'HeartbeatTestAgent' });
    sessionId = agent.session_id;
  });
  afterEach(() => { cleanupTestContext(ctx); });

  test('getLatest returns most recent heartbeat', () => {
    ctx.bb.sendHeartbeat({ sessionId, progress: 'First' });
    Bun.sleepSync(10);
    ctx.bb.sendHeartbeat({ sessionId, progress: 'Second' });
    Bun.sleepSync(10);
    ctx.bb.sendHeartbeat({ sessionId, progress: 'Third' });

    const latest = ctx.bb.heartbeatQueries.getLatest();
    expect(latest).not.toBeNull();
    expect(latest!.progress).toBe('Third');
  });

  test('getLatest returns null when no heartbeats exist', () => {
    expect(ctx.bb.heartbeatQueries.getLatest()).toBeNull();
  });

  test('getRecent returns limited recent heartbeats', () => {
    for (let i = 0; i < 5; i++) {
      ctx.bb.sendHeartbeat({ sessionId, progress: `Beat ${i}` });
    }
    const recent = ctx.bb.heartbeatQueries.getRecent(3);
    expect(recent.length).toBe(3);
    // Most recent first
    expect(recent[0].progress).toBe('Beat 4');
  });

  test('getSince returns heartbeats after given timestamp', () => {
    ctx.bb.sendHeartbeat({ sessionId, progress: 'Old beat' });
    const midpoint = new Date().toISOString();
    Bun.sleepSync(50);
    ctx.bb.sendHeartbeat({ sessionId, progress: 'New beat' });

    const since = ctx.bb.heartbeatQueries.getSince(midpoint);
    expect(since.some((h) => h.progress === 'New beat')).toBe(true);
  });

  test('getBySession returns heartbeats for specific session', () => {
    const agent2 = ctx.bb.registerAgent({ name: 'OtherAgent' });
    ctx.bb.sendHeartbeat({ sessionId, progress: 'Agent 1 beat' });
    ctx.bb.sendHeartbeat({ sessionId: agent2.session_id, progress: 'Agent 2 beat' });

    const beats = ctx.bb.heartbeatQueries.getBySession(sessionId);
    expect(beats.length).toBe(1);
    expect(beats[0].progress).toBe('Agent 1 beat');
  });

  test('heartbeat rows have expected shape', () => {
    ctx.bb.sendHeartbeat({ sessionId, progress: 'Check shape' });
    const latest = ctx.bb.heartbeatQueries.getLatest()!;

    expect(latest.id).toBeGreaterThan(0);
    expect(latest.session_id).toBe(sessionId);
    expect(typeof latest.timestamp).toBe('string'); // ISO string, not Date
    expect(latest.progress).toBe('Check shape');
    expect(latest.work_item_id).toBeNull();
  });
});

describe('EventQueryRepository', () => {
  let sessionId: string;

  beforeEach(() => {
    ctx = createTestContext();
    const agent = ctx.bb.registerAgent({ name: 'EventTestAgent' });
    sessionId = agent.session_id;
  });
  afterEach(() => { cleanupTestContext(ctx); });

  test('getRecent returns limited events in reverse chronological order', () => {
    // registerAgent already created an agent_registered event
    for (let i = 0; i < 3; i++) {
      ctx.bb.appendEvent({ actorId: sessionId, summary: `Event ${i}` });
    }
    const recent = ctx.bb.eventQueries.getRecent(3);
    expect(recent.length).toBe(3);
    // Most recent first
    expect(recent[0].summary).toBe('Event 2');
  });

  test('getByType filters events by type', () => {
    ctx.bb.appendEvent({ summary: 'Check 1' });
    ctx.bb.appendEvent({ summary: 'Check 2' });

    // All heartbeat_received events from appendEvent
    const hbEvents = ctx.bb.eventQueries.getByType('heartbeat_received');
    expect(hbEvents.length).toBe(2);

    // agent_registered events from registerAgent
    const regEvents = ctx.bb.eventQueries.getByType('agent_registered');
    expect(regEvents.length).toBe(1);
  });

  test('getByActor filters events by actor', () => {
    const agent2 = ctx.bb.registerAgent({ name: 'OtherAgent' });
    ctx.bb.appendEvent({ actorId: sessionId, summary: 'From agent 1' });
    ctx.bb.appendEvent({ actorId: agent2.session_id, summary: 'From agent 2' });

    const fromAgent1 = ctx.bb.eventQueries.getByActor(sessionId);
    // Includes the agent_registered event for this agent + the appended event
    const appended = fromAgent1.filter(e => e.summary === 'From agent 1');
    expect(appended.length).toBe(1);
  });

  test('getSince returns events after given timestamp', () => {
    ctx.bb.appendEvent({ summary: 'Old event' });
    const midpoint = new Date().toISOString();
    Bun.sleepSync(50);
    ctx.bb.appendEvent({ summary: 'New event' });

    const since = ctx.bb.eventQueries.getSince(midpoint);
    expect(since.some((e) => e.summary === 'New event')).toBe(true);
    expect(since.every((e) => e.summary !== 'Old event')).toBe(true);
  });

  test('getByType with limit option', () => {
    for (let i = 0; i < 5; i++) {
      ctx.bb.appendEvent({ summary: `Limited ${i}` });
    }
    const limited = ctx.bb.eventQueries.getByType('heartbeat_received', { limit: 2 });
    expect(limited.length).toBe(2);
  });

  test('getByActor with since option', () => {
    ctx.bb.appendEvent({ actorId: sessionId, summary: 'Before' });
    const midpoint = new Date().toISOString();
    Bun.sleepSync(50);
    ctx.bb.appendEvent({ actorId: sessionId, summary: 'After' });

    const filtered = ctx.bb.eventQueries.getByActor(sessionId, { since: midpoint });
    const summaries = filtered.map(e => e.summary);
    expect(summaries).toContain('After');
    expect(summaries).not.toContain('Before');
  });

  test('event rows have expected shape (ivy-blackboard schema)', () => {
    ctx.bb.appendEvent({
      actorId: sessionId,
      targetId: sessionId,
      summary: 'Shape check',
      metadata: { key: 'value' },
    });

    const recent = ctx.bb.eventQueries.getRecent(1);
    const event = recent[0];
    expect(event.id).toBeGreaterThan(0);
    expect(typeof event.timestamp).toBe('string'); // ISO string
    expect(event.event_type).toBe('heartbeat_received');
    expect(event.actor_id).toBe(sessionId);
    expect(event.target_id).toBe(sessionId);
    expect(event.target_type).toBe('agent');
    expect(event.summary).toBe('Shape check');
    expect(typeof event.metadata).toBe('string'); // JSON string from SQLite
  });
});
