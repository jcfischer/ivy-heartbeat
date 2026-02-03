#!/usr/bin/env bun

/**
 * Post-session hook for Claude Code.
 * Reads session transcript, extracts facts and patterns,
 * writes structured events to the blackboard.
 *
 * Usage: bun src/hooks/post-session.ts <jsonl-path> [--db <path>]
 */

import { existsSync } from 'node:fs';
import { Blackboard } from '../blackboard.ts';
import { parseTranscript, extractSessionSummary } from './transcript.ts';
import { extractFacts } from './extractor.ts';

function main(): void {
  const args = process.argv.slice(2);
  const jsonlPath = args[0];

  if (!jsonlPath) {
    console.error('Usage: post-session.ts <jsonl-path> [--db <path>]');
    process.exit(1);
  }

  if (!existsSync(jsonlPath)) {
    console.error(`Transcript not found: ${jsonlPath}`);
    process.exit(1);
  }

  // Optional --db flag
  const dbIdx = args.indexOf('--db');
  const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : undefined;

  const bb = new Blackboard(dbPath);

  try {
    const messages = parseTranscript(jsonlPath);
    if (messages.length === 0) {
      console.log('Empty transcript, skipping.');
      return;
    }

    const summary = extractSessionSummary(messages, jsonlPath);

    // Record session_started event
    bb.appendEvent({
      summary: `Session started: ${summary.projectPath}`,
      metadata: {
        hookEvent: 'session_started',
        sessionId: summary.sessionId,
        projectPath: summary.projectPath,
        startTime: summary.startTime,
      },
    });

    // Record session_activity event
    bb.appendEvent({
      summary: `Session activity: ${summary.messageCount} messages, ${summary.toolsUsed.length} tools, ${summary.filesModified.length} files`,
      metadata: {
        hookEvent: 'session_activity',
        sessionId: summary.sessionId,
        messageCount: summary.messageCount,
        toolsUsed: summary.toolsUsed,
        filesModified: summary.filesModified.slice(0, 50), // Limit to 50 files
        durationMinutes: summary.durationMinutes,
      },
    });

    // Extract and record facts
    const facts = extractFacts(summary.assistantMessages);
    for (const fact of facts.slice(0, 20)) {
      // Limit to 20 facts per session
      bb.appendEvent({
        summary: `${fact.type === 'fact' ? 'Fact extracted' : 'Pattern detected'}: ${fact.text}`,
        metadata: {
          hookEvent: fact.type === 'fact' ? 'fact_extracted' : 'pattern_detected',
          sessionId: summary.sessionId,
          text: fact.text,
          source: fact.source,
        },
      });
    }

    // Record session_ended event
    bb.appendEvent({
      summary: `Session ended: ${summary.projectPath} (${summary.durationMinutes}m)`,
      metadata: {
        hookEvent: 'session_ended',
        sessionId: summary.sessionId,
        projectPath: summary.projectPath,
        endTime: summary.endTime,
        durationMinutes: summary.durationMinutes,
        factsExtracted: facts.length,
      },
    });

    console.log(
      `Post-session hook: recorded ${4 + facts.length} events for session ${summary.sessionId.slice(0, 8)}…`
    );
  } finally {
    bb.close();
  }
}

main();
