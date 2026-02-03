import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { ChecklistItemSchema, type ChecklistItem } from './types.ts';

const KNOWN_FIELDS = new Set(['type', 'severity', 'channels', 'enabled', 'description']);

function resolvePath(path: string): string {
  return path.replace(/^~/, process.env.HOME || '');
}

/**
 * Extract config fields (anything beyond the known schema fields)
 */
function extractConfig(parsed: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!KNOWN_FIELDS.has(key)) {
      config[key] = value;
    }
  }
  return config;
}

/**
 * Parse a single section (## heading + yaml block) into a ChecklistItem
 */
function parseSection(name: string, yamlContent: string): ChecklistItem | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = yaml.load(yamlContent) as Record<string, unknown>;
  } catch (err) {
    console.warn(`Warning: Failed to parse YAML for "${name}": ${err}`);
    return null;
  }

  if (!parsed || typeof parsed !== 'object') {
    console.warn(`Warning: Empty or invalid YAML block for "${name}"`);
    return null;
  }

  const config = extractConfig(parsed);

  const input = {
    name,
    type: parsed.type,
    severity: parsed.severity,
    channels: parsed.channels,
    enabled: parsed.enabled,
    description: parsed.description,
    config: Object.keys(config).length > 0 ? config : {},
  };

  const result = ChecklistItemSchema.safeParse(input);

  if (!result.success) {
    console.warn(`Warning: Skipping "${name}": ${result.error.issues.map((i) => i.message).join(', ')}`);
    return null;
  }

  return result.data;
}

/**
 * Parse markdown content into ChecklistItem array
 */
export function parseContent(content: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];

  // Split by ## headings
  const sections = content.split(/^## /m);

  for (const section of sections) {
    if (!section.trim()) continue;

    // Extract heading (first line)
    const lines = section.split('\n');
    const heading = lines[0]?.trim();
    if (!heading) continue;

    // Skip if this looks like the top-level # heading content (no yaml block)
    const yamlMatch = section.match(/```ya?ml\s*\n([\s\S]*?)```/);
    if (!yamlMatch) continue;

    const yamlContent = yamlMatch[1]!;
    const item = parseSection(heading, yamlContent);
    if (item) {
      items.push(item);
    }
  }

  return items;
}

/**
 * Parse heartbeat checklist from file
 * @param path Path to IVY_HEARTBEAT.md (default: ~/.pai/IVY_HEARTBEAT.md)
 * @returns Array of valid ChecklistItem objects
 */
export function parseHeartbeatChecklist(path?: string): ChecklistItem[] {
  const resolvedPath = resolvePath(path ?? '~/.pai/IVY_HEARTBEAT.md');

  if (!existsSync(resolvedPath)) {
    return [];
  }

  const content = readFileSync(resolvedPath, 'utf-8');
  return parseContent(content);
}
