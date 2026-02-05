import type { Database } from 'bun:sqlite';
import {
  openDatabase,
  closeDatabase,
  resolveDbPath,
} from 'ivy-blackboard/src/db';
import {
  registerAgent,
  sendHeartbeat,
  deregisterAgent,
  type RegisterAgentOptions,
  type RegisterAgentResult,
  type HeartbeatOptions,
  type HeartbeatResult,
  type DeregisterAgentResult,
} from 'ivy-blackboard/src/agent';
import {
  createWorkItem,
  listWorkItems,
  claimWorkItem,
  completeWorkItem,
  releaseWorkItem,
  blockWorkItem,
  unblockWorkItem,
  setWaitingForResponse,
  updateWorkItemMetadata,
  type CreateWorkItemOptions,
  type CreateWorkItemResult,
  type ListWorkItemsOptions,
  type ClaimWorkItemResult,
  type CompleteWorkItemResult,
  type ReleaseWorkItemResult,
  type BlockWorkItemResult,
  type UnblockWorkItemResult,
  type SetWaitingResult,
  type UpdateWorkItemMetadataResult,
} from 'ivy-blackboard/src/work';
import { listProjects, type ProjectWithCounts } from 'ivy-blackboard/src/project';
import type { BlackboardProject, BlackboardWorkItem } from 'ivy-blackboard/src/types';
import { HeartbeatQueryRepository } from './repositories/heartbeats.ts';
import { EventQueryRepository } from './repositories/events.ts';
import { setupFTS5 } from './fts.ts';

/**
 * Ivy Heartbeat's interface to the blackboard.
 *
 * Delegates DB lifecycle and agent operations to ivy-blackboard.
 * Adds ivy-heartbeat-specific query repositories for heartbeats and events.
 */
export class Blackboard {
  readonly db: Database;
  readonly heartbeatQueries: HeartbeatQueryRepository;
  readonly eventQueries: EventQueryRepository;

  constructor(dbPath?: string) {
    const resolved = dbPath ?? resolveDbPath();
    this.db = openDatabase(resolved);
    setupFTS5(this.db);
    this.heartbeatQueries = new HeartbeatQueryRepository(this.db);
    this.eventQueries = new EventQueryRepository(this.db);
  }

  // ─── Agent lifecycle (delegated to ivy-blackboard) ─────────────────────

  registerAgent(opts: RegisterAgentOptions): RegisterAgentResult {
    return registerAgent(this.db, opts);
  }

  sendHeartbeat(opts: HeartbeatOptions): HeartbeatResult {
    return sendHeartbeat(this.db, opts);
  }

  deregisterAgent(sessionId: string): DeregisterAgentResult {
    return deregisterAgent(this.db, sessionId);
  }

  // ─── Work items (delegated to ivy-blackboard) ───────────────────────────

  createWorkItem(opts: CreateWorkItemOptions): CreateWorkItemResult {
    return createWorkItem(this.db, opts);
  }

  listWorkItems(opts?: ListWorkItemsOptions): BlackboardWorkItem[] {
    return listWorkItems(this.db, opts);
  }

  claimWorkItem(itemId: string, sessionId: string): ClaimWorkItemResult {
    return claimWorkItem(this.db, itemId, sessionId);
  }

  completeWorkItem(itemId: string, sessionId: string): CompleteWorkItemResult {
    return completeWorkItem(this.db, itemId, sessionId);
  }

  releaseWorkItem(itemId: string, sessionId: string): ReleaseWorkItemResult {
    return releaseWorkItem(this.db, itemId, sessionId);
  }

  blockWorkItem(itemId: string, opts?: { blockedBy?: string }): BlockWorkItemResult {
    return blockWorkItem(this.db, itemId, opts);
  }

  unblockWorkItem(itemId: string): UnblockWorkItemResult {
    return unblockWorkItem(this.db, itemId);
  }

  setWaitingForResponse(itemId: string, opts?: { blockedBy?: string }): SetWaitingResult {
    return setWaitingForResponse(this.db, itemId, opts);
  }

  updateWorkItemMetadata(itemId: string, updates: Record<string, unknown>): UpdateWorkItemMetadataResult {
    return updateWorkItemMetadata(this.db, itemId, updates);
  }

  /**
   * Complete a waiting_for_response item directly (no session required).
   * Used by the issue watcher evaluator when a watched dependency resolves.
   */
  completeWaitingItem(itemId: string): void {
    const now = new Date().toISOString();
    const result = this.db.query(
      "UPDATE work_items SET status = 'completed', completed_at = ? WHERE item_id = ? AND status = 'waiting_for_response'"
    ).run(now, itemId);
    if (result.changes > 0) {
      this.db.query(
        "INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary) VALUES (?, 'work_completed', 'issue-watcher', ?, 'work_item', ?)"
      ).run(now, itemId, `Waiting item "${itemId}" completed by issue watcher (dependency resolved)`);
    }
  }

  // ─── Projects (delegated to ivy-blackboard) ──────────────────────────

  getProject(projectId: string): BlackboardProject | null {
    return this.db
      .query('SELECT * FROM projects WHERE project_id = ?')
      .get(projectId) as BlackboardProject | null;
  }

  listProjects(): ProjectWithCounts[] {
    return listProjects(this.db);
  }

  // ─── Event appending (direct SQL — works around CHECK constraint) ──────

  /**
   * Append a heartbeat-specific event.
   * Uses ivy-blackboard's 'heartbeat_received' event type since custom
   * types are blocked by CHECK constraint (see issue #2).
   */
  appendEvent(opts: {
    actorId?: string;
    targetId?: string;
    summary: string;
    metadata?: Record<string, unknown>;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary, metadata)
         VALUES (?, 'heartbeat_received', ?, ?, 'agent', ?, ?)`
      )
      .run(
        now,
        opts.actorId ?? null,
        opts.targetId ?? null,
        opts.summary,
        opts.metadata ? JSON.stringify(opts.metadata) : null
      );
  }

  close(): void {
    closeDatabase(this.db);
  }
}

// Re-export types consumers need
export type {
  RegisterAgentOptions,
  RegisterAgentResult,
  HeartbeatOptions,
  HeartbeatResult,
  DeregisterAgentResult,
} from 'ivy-blackboard/src/agent';

export type {
  BlackboardAgent,
  BlackboardEvent,
  BlackboardHeartbeat,
  BlackboardProject,
  BlackboardWorkItem,
} from 'ivy-blackboard/src/types';

export type {
  CreateWorkItemOptions,
  CreateWorkItemResult,
  ListWorkItemsOptions,
  ClaimWorkItemResult,
  CompleteWorkItemResult,
  ReleaseWorkItemResult,
  BlockWorkItemResult,
  UnblockWorkItemResult,
  SetWaitingResult,
  UpdateWorkItemMetadataResult,
} from 'ivy-blackboard/src/work';

export type { ProjectWithCounts } from 'ivy-blackboard/src/project';

export * from './parser/types.ts';
export { HeartbeatQueryRepository } from './repositories/heartbeats.ts';
export { EventQueryRepository, type ListOptions, type SearchResult } from './repositories/events.ts';
export { setupFTS5, rebuildFTSIndex } from './fts.ts';
export { logCredentialAccess, logCredentialDenied } from './credential/audit.ts';
export { loadScopeConfig, isCredentialAllowed } from './credential/scope.ts';
export type { CredentialAccessEvent, CredentialScopeConfig } from './credential/types.ts';
