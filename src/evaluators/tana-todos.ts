import type { ChecklistItem } from '../parser/types.ts';
import type { CheckResult } from '../check/types.ts';
import type {
  TanaAccessor,
  TanaTodosConfig,
  TanaBlackboardAccessor,
  ContentFilterResult,
  ContentFilterFn,
  TanaWorkItemMetadata,
} from './tana-types.ts';
import { getTanaAccessor } from './tana-accessor.ts';

// ─── Config parsing ───────────────────────────────────────────────────────

/**
 * Parse tana_todos config from a checklist item's config fields.
 */
export function parseTanaTodosConfig(item: ChecklistItem): TanaTodosConfig {
  const tagId = typeof item.config.tag_id === 'string' ? item.config.tag_id : '';
  return {
    tagId,
    workspaceId: typeof item.config.workspace_id === 'string' ? item.config.workspace_id : undefined,
    limit: typeof item.config.limit === 'number' ? item.config.limit : 20,
    projectFieldId: typeof item.config.project_field_id === 'string' ? item.config.project_field_id : undefined,
  };
}

// ─── Injectable content filter (for testing) ──────────────────────────────

let contentFilter: ContentFilterFn = defaultContentFilter;

async function defaultContentFilter(content: string, label: string): Promise<ContentFilterResult> {
  const filterPath = process.env.CONTENT_FILTER_PATH;
  if (!filterPath) {
    return { decision: 'ALLOWED', matches: [] };
  }

  const { join } = await import('node:path');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const tmpDir = mkdtempSync(join(tmpdir(), 'hb-tana-filter-'));
  const tmpFile = join(tmpDir, `${label}.md`);

  try {
    writeFileSync(tmpFile, content);
    const proc = Bun.spawn(
      ['bun', 'run', filterPath, 'check', tmpFile, '--json', '--format', 'markdown'],
      { stdout: 'pipe', stderr: 'pipe' }
    );

    const output = await new Response(proc.stdout).text();
    await proc.exited;

    if (proc.exitCode === 2) {
      const parsed = JSON.parse(output);
      return { decision: 'BLOCKED', matches: parsed.matches ?? [] };
    }

    if (proc.exitCode === 0) {
      try {
        const parsed = JSON.parse(output);
        return { decision: parsed.decision ?? 'ALLOWED', matches: parsed.matches ?? [] };
      } catch {
        return { decision: 'ALLOWED', matches: [] };
      }
    }

    return { decision: 'ALLOWED', matches: [] };
  } catch {
    return { decision: 'ALLOWED', matches: [] };
  } finally {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function setTanaContentFilter(filter: ContentFilterFn): void {
  contentFilter = filter;
}

export function resetTanaContentFilter(): void {
  contentFilter = defaultContentFilter;
}

// ─── Injectable blackboard accessor (for testing) ─────────────────────────

let bbAccessor: TanaBlackboardAccessor | null = null;

export function setTanaBlackboardAccessor(accessor: TanaBlackboardAccessor): void {
  bbAccessor = accessor;
}

export function resetTanaBlackboardAccessor(): void {
  bbAccessor = null;
}

// ─── Evaluator ────────────────────────────────────────────────────────────

/**
 * Evaluate Tana todos: poll for #ivy-todo nodes and create blackboard work items.
 *
 * For each unchecked #ivy-todo node in Tana:
 * - Checks dedup against existing work items (by source_ref = tana node ID)
 * - Reads child content for task instructions
 * - Runs content through the content filter
 * - Optionally associates with a blackboard project by name match
 * - Creates a work item with source='tana'
 */
export async function evaluateTanaTodos(item: ChecklistItem): Promise<CheckResult> {
  if (!bbAccessor) {
    return {
      item,
      status: 'error',
      summary: `Tana todos check: ${item.name} — blackboard not configured`,
      details: { error: 'Blackboard accessor not set. Call setTanaBlackboardAccessor() before evaluating.' },
    };
  }

  const accessor = getTanaAccessor();

  const config = parseTanaTodosConfig(item);
  if (!config.tagId) {
    return {
      item,
      status: 'error',
      summary: `Tana todos check: ${item.name} — missing tag_id in config`,
      details: { error: 'tag_id is required in checklist config for tana_todos evaluator.' },
    };
  }

  try {
    // Fetch unchecked todos from Tana
    const todos = await accessor.searchTodos({
      tagId: config.tagId,
      workspaceId: config.workspaceId,
      limit: config.limit,
    });

    if (todos.length === 0) {
      return {
        item,
        status: 'ok',
        summary: `Tana todos check: ${item.name} — no new todos`,
        details: { todosChecked: 0, newTodos: 0 },
      };
    }

    // Build set of already-tracked Tana node IDs
    const existingItems = bbAccessor.listWorkItems({ all: true });
    const trackedNodeIds = new Set(
      existingItems
        .filter((w) => {
          if (w.source_ref && w.metadata) {
            try {
              const m = JSON.parse(w.metadata);
              return m.tana_node_id !== undefined;
            } catch { /* ignore */ }
          }
          // Also check source_ref directly (tana node IDs stored there)
          return false;
        })
        .map((w) => w.source_ref)
        .filter((ref): ref is string => ref !== null)
    );

    // Also track by source_ref directly for items with source='tana'
    for (const w of existingItems) {
      if (w.source_ref && w.metadata) {
        try {
          const m = JSON.parse(w.metadata);
          if (m.tana_node_id) {
            trackedNodeIds.add(m.tana_node_id);
          }
        } catch { /* ignore */ }
      }
      if (w.source_ref) {
        // Check if any existing work item has this as a tana source_ref
        // Work items created by this evaluator use the node ID as source_ref
        trackedNodeIds.add(w.source_ref);
      }
    }

    // Get projects for name-based association
    const projects = bbAccessor.listProjects();

    let totalNew = 0;
    const newTodoDetails: Array<{ nodeId: string; title: string; project: string | null }> = [];

    for (const todo of todos) {
      // Skip if already tracked
      if (trackedNodeIds.has(todo.id)) continue;

      // Read child content for instructions
      let childContent = '';
      let minimalContext = true;
      try {
        const nodeContent = await accessor.readNode(todo.id, 2);
        // Extract text from markdown (children are the instructions)
        if (nodeContent.markdown && nodeContent.markdown.trim().length > 0) {
          // Strip the first line (the node name itself) from the markdown
          const lines = nodeContent.markdown.split('\n');
          const childLines = lines.slice(1).join('\n').trim();
          if (childLines.length > 0) {
            childContent = childLines;
            minimalContext = false;
          }
        }
      } catch {
        // Failed to read child content — proceed with minimal context
      }

      // Run content through filter
      const contentToFilter = childContent || todo.name;
      let filterResult: ContentFilterResult;
      try {
        filterResult = await contentFilter(
          contentToFilter,
          `tana-${todo.id}`
        );
      } catch {
        // Fail-open: if the content filter itself errors, allow the content
        filterResult = { decision: 'ALLOWED', matches: [] };
      }

      const hasPatternMatches = filterResult.matches.length > 0;
      const contentBlocked = filterResult.decision === 'BLOCKED' && hasPatternMatches;
      const contentWarning = filterResult.decision === 'BLOCKED' && !hasPatternMatches;

      // Project association by name match
      let projectId: string | null = null;
      let projectName: string | null = null;
      if (config.projectFieldId && todo.description) {
        // Try to match project name from node description/fields
        const matchedProject = projects.find(
          (p) => p.name.toLowerCase() === todo.description!.toLowerCase()
        );
        if (matchedProject) {
          projectId = matchedProject.project_id;
          projectName = matchedProject.name;
        }
      }

      // Build description
      const descParts = [todo.name];

      if (contentBlocked) {
        descParts.push(
          '',
          '## ⚠ Content Blocked',
          'Task content was blocked by content filter (prompt injection detected).',
          `Matched patterns: ${filterResult.matches.map((m) => m.pattern_id).join(', ')}`,
          'Review the task manually before acting on it.',
        );
      } else if (childContent) {
        if (contentWarning) {
          descParts.push(
            '',
            '## ⚠ Content Warning',
            'Content filter flagged encoding anomalies (no injection patterns matched). Content included for review.',
          );
        }
        descParts.push(
          '',
          '## Task Instructions',
          childContent,
        );
      }

      const description = descParts.filter(Boolean).join('\n');

      const metadata: TanaWorkItemMetadata = {
        tana_node_id: todo.id,
        tana_workspace_id: todo.workspaceId,
        tana_tag_id: config.tagId,
        content_filtered: true,
        content_blocked: contentBlocked,
        content_warning: contentWarning,
        filter_matches: filterResult.matches.map((m) => m.pattern_id),
        minimal_context: minimalContext || undefined,
        project_name: projectName || undefined,
        human_review_required: contentBlocked || undefined,
      };

      const itemId = `tana-${todo.id}`;

      try {
        bbAccessor.createWorkItem({
          id: itemId,
          title: todo.name,
          description,
          project: projectId,
          source: 'tana',
          sourceRef: todo.id,
          priority: 'P2',
          metadata: JSON.stringify(metadata),
        });

        totalNew++;
        newTodoDetails.push({
          nodeId: todo.id,
          title: todo.name,
          project: projectName,
        });
      } catch {
        // Work item may already exist — skip
      }
    }

    if (totalNew > 0) {
      return {
        item,
        status: 'alert',
        summary: `Tana todos check: ${item.name} — ${totalNew} new todo(s) found`,
        details: {
          todosChecked: todos.length,
          newTodos: totalNew,
          todos: newTodoDetails,
        },
      };
    }

    return {
      item,
      status: 'ok',
      summary: `Tana todos check: ${item.name} — no new todos`,
      details: {
        todosChecked: todos.length,
        newTodos: 0,
      },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      item,
      status: 'error',
      summary: `Tana todos check: ${item.name} — error: ${msg}`,
      details: { error: msg },
    };
  }
}
