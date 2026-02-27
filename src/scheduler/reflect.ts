/**
 * REFLECT phase orchestrator
 *
 * Runs after PR merge to extract structured lessons from the completed
 * specify→implement→review→merge cycle.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
function buildReflectPrompt(context: ReflectContext, outputPath: string): string {
  return `# Reflect Phase — Extract Implementation Lessons

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

Use the PAI Algorithm to analyze the gap between:
1. What the spec described
2. What was implemented
3. What review caught
4. What rework fixed

Extract lessons that would prevent similar issues in future implementations.

## Output

Write a JSON array of lesson objects to: \`${outputPath}\`

Use the Write tool to write the file. Each lesson must follow this schema:

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

Write the JSON array to the file at \`${outputPath}\` using the Write tool. This is the primary deliverable.`;
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

  // Step 2: Build prompt, launch agent with full PAI Algorithm
  // Agent writes lessons to a temp JSON file via the Write tool
  const outputPath = join(tmpdir(), `reflect-lessons-${Date.now()}.json`);
  const prompt = buildReflectPrompt(context, outputPath);

  console.log(`[reflect] Launching reflect agent (full PAI Algorithm), output: ${outputPath}`);

  const REFLECT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — full algorithm run
  const sessionId = `reflect-${metadata.implementation_work_item_id}-${Date.now()}`;
  const workDir = process.env.HOME ?? '/tmp';

  const launcher = getLauncher();
  try {
    await launcher({
      sessionId,
      prompt,
      workDir,
      timeoutMs: REFLECT_TIMEOUT_MS,
    });
  } catch (error) {
    console.error(`[reflect] Agent execution failed:`, error);
    throw new Error(`Reflect agent failed: ${error}`);
  }

  // Step 3: Read and parse the lessons file written by the agent
  console.log(`[reflect] Reading lessons from ${outputPath}`);

  if (!existsSync(outputPath)) {
    throw new Error(`Reflect agent did not write lessons file at ${outputPath}`);
  }

  let rawLessons: unknown[];
  try {
    const content = await Bun.file(outputPath).text();
    // Clean up temp file
    try { unlinkSync(outputPath); } catch { /* best effort */ }

    rawLessons = JSON.parse(content);
    if (!Array.isArray(rawLessons)) {
      throw new Error("Lessons file is not a JSON array");
    }
  } catch (error) {
    console.error(`[reflect] Failed to parse lessons file:`, error);
    throw new Error(`Invalid lessons file: ${error}`);
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
