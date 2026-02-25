/**
 * Type definitions for the REFLECT phase - post-merge lesson extraction system
 */

/**
 * Core lesson record structure extracted from completed SpecFlow cycles
 */
export interface LessonRecord {
  /** Unique identifier in format: lesson-{project}-{timestamp} */
  id: string;
  /** Repository/project name (e.g., "ivy-heartbeat") */
  project: string;
  /** Source work item ID that produced this lesson */
  workItemId: string;
  /** Which phase the issue surfaced in */
  phase: "implement" | "review" | "rework" | "merge-fix";
  /** Category for grouping related lessons */
  category: string;
  /** Impact level of the lesson */
  severity: "low" | "medium" | "high";
  /** Observable behavior - what went wrong */
  symptom: string;
  /** Underlying reason - why it went wrong */
  rootCause: string;
  /** How the issue was fixed */
  resolution: string;
  /** Actionable rule in imperative voice */
  constraint: string;
  /** Searchable keywords */
  tags: string[];
  /** ISO 8601 timestamp */
  createdAt: string;
}

/**
 * Metadata for reflect work items on the blackboard
 */
export interface ReflectMetadata {
  /** Flag indicating this is a reflect work item */
  reflect: true;
  /** Project identifier */
  project_id: string;
  /** Work item that was implemented */
  implementation_work_item_id: string;
  /** Pull request number */
  pr_number: number;
  /** Pull request URL */
  pr_url: string;
}

/**
 * Result summary from a reflect phase execution
 */
export interface ReflectResult {
  /** Number of lessons extracted from agent output */
  lessonsExtracted: number;
  /** Number of lessons skipped as duplicates */
  lessonsDeduped: number;
  /** Number of lessons actually persisted */
  lessonsPersisted: number;
  /** Unique categories found */
  categories: string[];
  /** Work item ID this reflect run processed */
  workItemId: string;
}

/**
 * Query parameters for searching lessons
 */
export interface LessonQuery {
  /** Filter by project name */
  project?: string;
  /** Filter by category */
  category?: string;
  /** Filter by severity level */
  severity?: "low" | "medium" | "high";
  /** FTS5 search text */
  searchText?: string;
  /** Maximum results to return */
  limit?: number;
}

/**
 * Context gathered for reflect agent analysis
 */
export interface ReflectContext {
  /** Project name */
  project: string;
  /** Work item ID */
  workItemId: string;
  /** PR URL for reference */
  prUrl: string;
  /** Original specification content */
  specContent: string;
  /** Technical plan content */
  planContent: string;
  /** Review feedback and results */
  reviewResults: string;
  /** Rework cycle history */
  reworkHistory: string;
  /** Final diff summary */
  diffSummary: string;
}
