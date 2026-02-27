/**
 * REFLECT phase orchestrator
 *
 * Runs after PR merge to extract structured lessons from the completed
 * specify→implement→review→merge cycle.
 */

import type { Database } from "bun:sqlite";
import type { ReflectMetadata, ReflectResult, LessonRecord, ReflectContext } from "../reflect/types";
import { LessonRecordSchema } from "../reflect/lesson-schema";
import {
  gatherReflectInputs,
  persistLesson,
  isLessonDuplicate,
  logDuplicateLesson,
} from "../reflect/analyzer";
import { getLauncher } from "./launcher.ts";

/**
 * Parse and validate reflect metadata from work item
 *
 * @param metadata Work item metadata
 * @returns Validated ReflectMetadata
 * @throws Error if metadata is invalid
 */
export function parseReflectMeta(metadata: unknown): ReflectMetadata {
  if (!metadata || typeof metadata !== "object") {
    throw new Error("Invalid reflect metadata: not an object");
  }

  const meta = metadata as Record<string, unknown>;

  if (meta.reflect !== true) {
    throw new Error("Invalid reflect metadata: missing reflect flag");
  }

  if (typeof meta.project_id !== "string" || !meta.project_id) {
    throw new Error("Invalid reflect metadata: missing project_id");
  }

  if (typeof meta.implementation_work_item_id !== "string" || !meta.implementation_work_item_id) {
    throw new Error("Invalid reflect metadata: missing implementation_work_item_id");
  }

  if (typeof meta.pr_number !== "number") {
    throw new Error("Invalid reflect metadata: missing pr_number");
  }

  if (typeof meta.pr_url !== "string" || !meta.pr_url) {
    throw new Error("Invalid reflect metadata: missing pr_url");
  }

  return {
    reflect: true,
    project_id: meta.project_id,
    implementation_work_item_id: meta.implementation_work_item_id,
    pr_number: meta.pr_number,
    pr_url: meta.pr_url,
  };
}

/**
 * Build prompt for reflect agent
 *
 * @param context Gathered reflect inputs
 * @returns Formatted prompt for agent
 */
const REFLECT_PREAMBLE = `EXECUTION MODE: JSON Output Only

You are a lesson extraction agent. Do NOT use PAI Algorithm format, ISC creation, phase headers (━━━), voice notification curls, or any other formatting. Your ENTIRE output must be a single valid JSON array — nothing else.

`;

function buildReflectPrompt(context: ReflectContext): string {
  return `${REFLECT_PREAMBLE}# Reflect Phase — Extract Implementation Lessons

## Context

You are analyzing a completed SpecFlow cycle to extract actionable lessons for future agents.

**Project:** ${context.project}
**Work Item:** ${context.workItemId}
**PR:** ${context.prUrl}

## Inputs

### Original Specification
${context.specContent || "(No spec content available)"}

### Technical Plan
${context.planContent || "(No plan content available)"}

### Review Feedback
${context.reviewResults || "(No review feedback available)"}

### Rework History
${context.reworkHistory || "(No rework cycles)"}

### Final Diff Summary
${context.diffSummary || "(No diff summary available)"}

## Task

Analyze the gap between:
1. What the spec described
2. What was implemented
3. What review caught
4. What rework fixed

Extract lessons that would prevent similar issues in future implementations.

## Output Format

Return a JSON array of lesson objects. Each lesson must follow this schema:

\`\`\`json
[
  {
    "phase": "implement | review | rework | merge-fix",
    "category": "testing | types | architecture | edge-cases | dependencies | ...",
    "severity": "low | medium | high",
    "symptom": "Observable behavior — what went wrong",
    "rootCause": "Why it went wrong — underlying reason",
    "resolution": "How it was fixed",
    "constraint": "Actionable rule in imperative voice: 'Always...', 'Never...', 'When X, do Y...'",
    "tags": ["keyword1", "keyword2"]
  }
]
\`\`\`

## Quality Requirements

- **Actionability:** Constraints must be imperative and specific
- **Specificity:** Root cause must differ from symptom (not just restating)
- **Uniqueness:** Avoid near-duplicates of existing lessons
- **Minimum yield:** Extract at least 1 lesson per analysis

Output only the JSON array. No commentary.`;
}

/**
 * Run the reflect phase
 *
 * Orchestrates the complete reflect pipeline:
 * 1. Gather inputs from blackboard events
 * 2. Build and launch reflect agent
 * 3. Parse and validate agent output
 * 4. Deduplicate lessons
 * 5. Persist validated unique lessons
 * 6. Log reflect.completed event with stats
 *
 * @param db Database connection
 * @param metadata Validated reflect metadata
 * @returns Reflect result with statistics
 */
export async function runReflect(
  db: Database,
  metadata: ReflectMetadata
): Promise<ReflectResult> {
  console.log(`[reflect] Starting reflect for work item: ${metadata.implementation_work_item_id}`);

  // Step 1: Gather inputs
  const context = gatherReflectInputs(db, metadata);
  console.log(`[reflect] Gathered inputs from blackboard`);

  // Step 2: Build prompt and launch agent
  const prompt = buildReflectPrompt(context);

  console.log(`[reflect] Launching reflect agent via launcher`);

  const REFLECT_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes — JSON extraction only
  const sessionId = `reflect-${metadata.implementation_work_item_id}-${Date.now()}`;
  const workDir = process.env.HOME ?? '/tmp';

  const launcher = getLauncher();
  let launchResult: Awaited<ReturnType<typeof launcher>>;
  try {
    launchResult = await launcher({
      sessionId,
      prompt,
      workDir,
      timeoutMs: REFLECT_TIMEOUT_MS,
      disableMcp: true,
    });
  } catch (error) {
    console.error(`[reflect] Agent execution failed:`, error);
    throw new Error(`Reflect agent failed: ${error}`);
  }

  // Extract the final result text from stream-json output.
  // The launcher streams JSON lines; the last "result" message carries the agent's output.
  let agentOutput = '';
  const lines = launchResult.stdout.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'result' && msg.result) {
        agentOutput = msg.result.trim();
      }
    } catch { /* raw line — ignore */ }
  }
  // Fallback: if no result message found, use full stdout (legacy --print mode)
  if (!agentOutput) {
    agentOutput = launchResult.stdout.trim();
  }

  // Step 3: Parse and validate JSON output
  console.log(`[reflect] Parsing agent output`);

  let rawLessons: unknown[];
  try {
    rawLessons = JSON.parse(agentOutput);

    if (!Array.isArray(rawLessons)) {
      throw new Error("Agent output is not an array");
    }
  } catch (error) {
    console.error(`[reflect] Failed to parse agent output as JSON:`, error);
    console.error(`[reflect] Raw output:`, agentOutput.substring(0, 500));
    throw new Error(`Invalid agent output: ${error}`);
  }

  // Step 4 & 5: Validate, deduplicate, and persist lessons
  let lessonsExtracted = 0;
  let lessonsDeduped = 0;
  let lessonsPersisted = 0;
  const categories = new Set<string>();

  for (const rawLesson of rawLessons) {
    lessonsExtracted++;

    // Validate with Zod
    const validation = LessonRecordSchema.safeParse({
      id: `lesson-${context.project}-${Date.now()}-${lessonsExtracted}`,
      project: context.project,
      workItemId: context.workItemId,
      createdAt: new Date().toISOString(),
      ...rawLesson,
    });

    if (!validation.success) {
      console.warn(`[reflect] Lesson ${lessonsExtracted} failed validation:`, validation.error);
      continue;
    }

    const lesson = validation.data;
    categories.add(lesson.category);

    // Check for duplicates
    if (isLessonDuplicate(db, lesson)) {
      console.log(`[reflect] Lesson ${lessonsExtracted} is duplicate, skipping`);
      lessonsDeduped++;
      logDuplicateLesson(db, "existing-lesson", lesson.constraint);
      continue;
    }

    // Persist lesson
    persistLesson(db, lesson);
    lessonsPersisted++;
    console.log(`[reflect] Persisted lesson: ${lesson.constraint.substring(0, 60)}...`);
  }

  // Step 6: Log reflect.completed event
  const result: ReflectResult = {
    lessonsExtracted,
    lessonsDeduped,
    lessonsPersisted,
    categories: Array.from(categories),
    workItemId: context.workItemId,
  };

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary, metadata)
     VALUES (?, 'reflect.completed', 'reflect-orchestrator', ?, 'work_item', ?, ?)`
  ).run(
    now,
    context.workItemId,
    `Reflect completed: ${lessonsPersisted} lessons persisted`,
    JSON.stringify(result)
  );

  console.log(`[reflect] Completed: ${lessonsPersisted}/${lessonsExtracted} lessons persisted`);

  return result;
}
