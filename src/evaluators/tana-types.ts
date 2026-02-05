import type { ProjectWithCounts } from '../blackboard.ts';

// ─── Tana MCP response types ─────────────────────────────────────────────

export interface TanaNode {
  id: string;
  name: string;
  tags?: string[];
  workspaceId?: string;
  description?: string;
  created?: string;
}

export interface TanaNodeContent {
  id: string;
  name: string;
  markdown: string;
  children?: string[];
}

// ─── TanaAccessor interface (injectable for testing) ──────────────────────

/**
 * Injectable Tana MCP accessor — mirrors the BlackboardAccessor pattern.
 * Each method maps to a tana-local MCP tool.
 */
export interface TanaAccessor {
  /** search_nodes with hasType filter for ivy-todo tag, unchecked only */
  searchTodos(opts: {
    tagId: string;
    workspaceId?: string;
    limit?: number;
  }): Promise<TanaNode[]>;

  /** read_node with depth to get child content */
  readNode(nodeId: string, maxDepth?: number): Promise<TanaNodeContent>;

  /** import_tana_paste to add result child under a node */
  addChildContent(parentNodeId: string, content: string): Promise<void>;

  /** check_node to mark todo as done */
  checkNode(nodeId: string): Promise<void>;
}

// ─── Config types ─────────────────────────────────────────────────────────

export interface TanaTodosConfig {
  /** The Tana supertag ID for #ivy-todo (required) */
  tagId: string;
  /** Tana workspace ID (optional — defaults to first available) */
  workspaceId?: string;
  /** Max todos to fetch per evaluation (default: 20) */
  limit: number;
  /** Tana field ID for "Project" field on ivy-todo nodes (optional) */
  projectFieldId?: string;
}

// ─── Work item metadata ───────────────────────────────────────────────────

export interface TanaWorkItemMetadata {
  tana_node_id: string;
  tana_workspace_id?: string;
  tana_tag_id: string;
  content_filtered: boolean;
  content_blocked: boolean;
  content_warning?: boolean;
  filter_matches: string[];
  minimal_context?: boolean;
  project_name?: string;
  human_review_required?: boolean;
}

// ─── Content filter types (shared with github-issues) ─────────────────────

export interface ContentFilterResult {
  decision: 'ALLOWED' | 'BLOCKED' | 'HUMAN_REVIEW';
  matches: Array<{ pattern_id: string; pattern_name: string; matched_text: string }>;
}

export type ContentFilterFn = (content: string, label: string) => Promise<ContentFilterResult>;

// ─── Blackboard accessor (minimal interface for the evaluator) ────────────

export type TanaBlackboardAccessor = {
  listProjects(): ProjectWithCounts[];
  listWorkItems(opts?: { all?: boolean; project?: string }): Array<{
    source_ref: string | null;
    metadata?: string | null;
    status?: string;
  }>;
  createWorkItem(opts: {
    id: string;
    title: string;
    description?: string;
    project?: string | null;
    source?: string;
    sourceRef?: string;
    priority?: string;
    metadata?: string;
  }): unknown;
};
