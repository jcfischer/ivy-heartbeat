import { readFileSync } from 'node:fs';

export interface TranscriptMessage {
  type: string;
  role?: string;
  content?: string | Array<{ type: string; text?: string; name?: string }>;
  timestamp?: string;
  tool_use?: { name: string; input: Record<string, unknown> };
}

export interface SessionSummary {
  sessionId: string;
  projectPath: string;
  startTime: string;
  endTime: string;
  durationMinutes: number;
  messageCount: number;
  toolsUsed: string[];
  filesModified: string[];
  assistantMessages: string[];
}

/**
 * Parse a Claude Code JSONL transcript file into messages.
 */
export function parseTranscript(jsonlPath: string): TranscriptMessage[] {
  const content = readFileSync(jsonlPath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());
  const messages: TranscriptMessage[] = [];

  for (const line of lines) {
    try {
      messages.push(JSON.parse(line) as TranscriptMessage);
    } catch {
      // Skip malformed lines
    }
  }

  return messages;
}

/**
 * Extract session summary from parsed transcript messages.
 */
export function extractSessionSummary(
  messages: TranscriptMessage[],
  jsonlPath: string
): SessionSummary {
  // Extract session ID from filename
  const pathParts = jsonlPath.split('/');
  const filename = pathParts[pathParts.length - 1] ?? '';
  const sessionId = filename.replace('.jsonl', '');

  // Extract project path from the directory structure
  // Typical: ~/.claude/projects/-Users-name-project/session.jsonl
  const projectDir = pathParts[pathParts.length - 2] ?? '';
  const projectPath = projectDir.replace(/-/g, '/').replace(/^\//, '');

  // Find timestamps
  const timestamps = messages
    .filter((m) => m.timestamp)
    .map((m) => m.timestamp!)
    .sort();
  const startTime = timestamps[0] ?? new Date().toISOString();
  const endTime = timestamps[timestamps.length - 1] ?? startTime;

  const startMs = new Date(startTime).getTime();
  const endMs = new Date(endTime).getTime();
  const durationMinutes = Math.round((endMs - startMs) / 60_000);

  // Extract tools used
  const toolsUsed = new Set<string>();
  for (const msg of messages) {
    if (msg.tool_use?.name) {
      toolsUsed.add(msg.tool_use.name);
    }
    // Also check content array for tool_use blocks
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.name) {
          toolsUsed.add(block.name);
        }
      }
    }
  }

  // Extract files mentioned in Write/Edit/Read tool calls
  const filesModified = new Set<string>();
  for (const msg of messages) {
    if (msg.tool_use?.input) {
      const filePath =
        msg.tool_use.input.file_path ?? msg.tool_use.input.path;
      if (typeof filePath === 'string' && filePath.startsWith('/')) {
        filesModified.add(filePath);
      }
    }
  }

  // Extract assistant text messages
  const assistantMessages: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      if (typeof msg.content === 'string' && msg.content.trim()) {
        assistantMessages.push(msg.content.trim());
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text?.trim()) {
            assistantMessages.push(block.text.trim());
          }
        }
      }
    }
  }

  return {
    sessionId,
    projectPath,
    startTime,
    endTime,
    durationMinutes,
    messageCount: messages.length,
    toolsUsed: [...toolsUsed],
    filesModified: [...filesModified],
    assistantMessages,
  };
}
