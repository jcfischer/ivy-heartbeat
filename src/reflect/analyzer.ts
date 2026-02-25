/**
 * Reflect phase analyzer - input gathering, lesson persistence, and querying
 */

import type { Database } from "bun:sqlite";
import type {
  LessonRecord,
  LessonQuery,
  ReflectMetadata,
  ReflectContext,
} from "./types";

/**
 * Persist a lesson to the blackboard as a lesson.created event
 *
 * The searchable summary concatenates symptom, rootCause, resolution, and constraint
 * for FTS5 indexing. The full LessonRecord is stored in metadata as JSON.
 *
 * @param db Database connection
 * @param lesson Validated lesson record to persist
 */
export function persistLesson(db: Database, lesson: LessonRecord): void {
  const now = new Date().toISOString();

  // Concatenate searchable text for FTS5 indexing
  const searchableSummary = `${lesson.symptom} ${lesson.rootCause} ${lesson.resolution} ${lesson.constraint}`;

  db.prepare(
    `INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary, metadata)
     VALUES (?, 'lesson.created', 'reflect-agent', ?, 'work_item', ?, ?)`
  ).run(now, lesson.workItemId, searchableSummary, JSON.stringify(lesson));
}

/**
 * Query lessons from blackboard with optional filters
 *
 * Supports filtering by project, category, severity, and FTS5 text search.
 * Results are ranked by relevance (FTS5 rank) and recency (timestamp DESC).
 *
 * @param db Database connection
 * @param query Query parameters
 * @returns Array of lesson records matching the query
 */
export function queryLessons(db: Database, query: LessonQuery): LessonRecord[] {
  const conditions: string[] = ["e.event_type = 'lesson.created'"];
  const params: (string | number)[] = [];

  // If FTS5 search provided, use it
  if (query.searchText) {
    const sql = `
      SELECT e.metadata
      FROM events_fts fts
      JOIN events e ON e.id = fts.rowid
      WHERE e.event_type = 'lesson.created'
        AND events_fts MATCH ?
      ORDER BY fts.rank
      LIMIT ?
    `;

    const limit = query.limit ?? 50;
    const rows = db.prepare(sql).all(query.searchText, limit) as Array<{ metadata: string }>;

    return rows
      .map(row => JSON.parse(row.metadata) as LessonRecord)
      .filter(lesson => matchesFilters(lesson, query));
  }

  // Build WHERE clause for non-FTS queries
  if (query.project) {
    conditions.push("json_extract(e.metadata, '$.project') = ?");
    params.push(query.project);
  }

  if (query.category) {
    conditions.push("json_extract(e.metadata, '$.category') = ?");
    params.push(query.category);
  }

  if (query.severity) {
    conditions.push("json_extract(e.metadata, '$.severity') = ?");
    params.push(query.severity);
  }

  const where = conditions.join(" AND ");
  const limit = query.limit ?? 50;

  const sql = `
    SELECT e.metadata
    FROM events e
    WHERE ${where}
    ORDER BY e.timestamp DESC
    LIMIT ?
  `;

  params.push(limit);

  const rows = db.prepare(sql).all(...params) as Array<{ metadata: string }>;
  return rows.map(row => JSON.parse(row.metadata) as LessonRecord);
}

/**
 * Helper to check if a lesson matches filter criteria
 */
function matchesFilters(lesson: LessonRecord, query: LessonQuery): boolean {
  if (query.project && lesson.project !== query.project) {
    return false;
  }
  if (query.category && lesson.category !== query.category) {
    return false;
  }
  if (query.severity && lesson.severity !== query.severity) {
    return false;
  }
  return true;
}

/**
 * Check if a lesson is a duplicate based on constraint token overlap
 *
 * Queries existing lessons and calculates token overlap similarity.
 * Returns true if any existing lesson has >80% token overlap with the new lesson's constraint.
 *
 * @param db Database connection
 * @param newLesson Lesson to check for duplicates
 * @returns true if duplicate detected, false otherwise
 */
export function isLessonDuplicate(db: Database, newLesson: LessonRecord): boolean {
  // Get all existing lessons
  const existing = queryLessons(db, {});

  // Calculate token overlap for each existing lesson
  for (const existingLesson of existing) {
    const similarity = calculateTokenOverlap(
      newLesson.constraint,
      existingLesson.constraint
    );

    if (similarity >= 0.8) {
      return true;
    }
  }

  return false;
}

/**
 * Calculate token overlap similarity between two strings
 *
 * Simple word-set intersection algorithm:
 * 1. Normalize both strings (lowercase, trim)
 * 2. Split into word sets
 * 3. Calculate intersection / union
 *
 * @param str1 First string
 * @param str2 Second string
 * @returns Similarity score 0-1 (1 = identical, 0 = no overlap)
 */
function calculateTokenOverlap(str1: string, str2: string): number {
  // Normalize and tokenize
  const tokens1 = new Set(
    str1.toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 0)
  );

  const tokens2 = new Set(
    str2.toLowerCase()
      .split(/\s+/)
      .filter(t => t.length > 0)
  );

  // Calculate intersection
  const intersection = new Set(
    [...tokens1].filter(t => tokens2.has(t))
  );

  // Calculate union
  const union = new Set([...tokens1, ...tokens2]);

  if (union.size === 0) {
    return 0;
  }

  return intersection.size / union.size;
}

/**
 * Log a duplicate lesson event
 *
 * @param db Database connection
 * @param duplicateOf ID of the existing lesson this duplicates
 * @param constraint The duplicate constraint text
 */
export function logDuplicateLesson(
  db: Database,
  duplicateOf: string,
  constraint: string
): void {
  const now = new Date().toISOString();

  // Note: Using 'work_item' for target_type to work around CHECK constraint
  // (issue #2: custom types are blocked by CHECK constraint)
  db.prepare(
    `INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary, metadata)
     VALUES (?, 'lesson.deduplicated', 'reflect-agent', NULL, 'work_item', ?, ?)`
  ).run(
    now,
    `Duplicate lesson skipped: ${constraint.substring(0, 60)}...`,
    JSON.stringify({ duplicateOf, constraint })
  );
}

/**
 * Gather all required inputs for reflect agent analysis
 *
 * Queries blackboard events to extract:
 * - Spec content (from specify phase artifacts)
 * - Plan content (from plan phase artifacts)
 * - Review results (from code_review.completed events)
 * - Rework history (from rework cycle events)
 * - Diff summary (from PR merge events)
 *
 * @param db Database connection
 * @param metadata Reflect work item metadata
 * @returns Complete reflect context for agent analysis
 */
export function gatherReflectInputs(
  db: Database,
  metadata: ReflectMetadata
): ReflectContext {
  const workItemId = metadata.implementation_work_item_id;

  // Query spec content
  let specContent = "";
  const specRows = db.prepare(
    `SELECT metadata FROM events
     WHERE target_id = ?
       AND event_type = 'artifact.created'
       AND json_extract(metadata, '$.artifact_type') = 'spec'
     ORDER BY timestamp DESC
     LIMIT 1`
  ).all(workItemId) as Array<{ metadata: string }>;

  if (specRows.length > 0) {
    const specMeta = JSON.parse(specRows[0].metadata);
    specContent = specMeta.content || "";
  }

  // Query plan content
  let planContent = "";
  const planRows = db.prepare(
    `SELECT metadata FROM events
     WHERE target_id = ?
       AND event_type = 'artifact.created'
       AND json_extract(metadata, '$.artifact_type') = 'plan'
     ORDER BY timestamp DESC
     LIMIT 1`
  ).all(workItemId) as Array<{ metadata: string }>;

  if (planRows.length > 0) {
    const planMeta = JSON.parse(planRows[0].metadata);
    planContent = planMeta.content || "";
  }

  // Query review results
  let reviewResults = "";
  const reviewRows = db.prepare(
    `SELECT summary, metadata FROM events
     WHERE target_id = ?
       AND event_type = 'code_review.completed'
     ORDER BY timestamp DESC`
  ).all(workItemId) as Array<{ summary: string; metadata: string }>;

  if (reviewRows.length > 0) {
    reviewResults = reviewRows.map(row => {
      const meta = JSON.parse(row.metadata);
      const issues = meta.issues ? `\nIssues: ${meta.issues.join(", ")}` : "";
      return `${row.summary}${issues}`;
    }).join("\n\n");
  }

  // Query rework history
  let reworkHistory = "";
  const reworkRows = db.prepare(
    `SELECT summary, metadata FROM events
     WHERE target_id = ?
       AND event_type LIKE 'rework.%'
     ORDER BY timestamp ASC`
  ).all(workItemId) as Array<{ summary: string; metadata: string }>;

  if (reworkRows.length > 0) {
    reworkHistory = reworkRows.map(row => {
      const meta = JSON.parse(row.metadata);
      const details = meta.fixing ? `Fixing: ${meta.fixing}` : "";
      return `${row.summary} ${details}`.trim();
    }).join("\n");
  }

  // Query diff summary from PR merge
  let diffSummary = "";
  const prRows = db.prepare(
    `SELECT metadata FROM events
     WHERE target_id = ?
       AND event_type = 'pr.merged'
     ORDER BY timestamp DESC
     LIMIT 1`
  ).all(workItemId) as Array<{ metadata: string }>;

  if (prRows.length > 0) {
    const prMeta = JSON.parse(prRows[0].metadata);
    diffSummary = prMeta.diff_summary || "";
  }

  return {
    project: metadata.project_id,
    workItemId: metadata.implementation_work_item_id,
    prUrl: metadata.pr_url,
    specContent,
    planContent,
    reviewResults,
    reworkHistory,
    diffSummary,
  };
}
