import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  gatherReflectInputs,
  persistLesson,
  queryLessons,
  isLessonDuplicate,
  logDuplicateLesson,
} from "../../src/reflect/analyzer";
import type { LessonRecord, LessonQuery, ReflectMetadata } from "../../src/reflect/types";
import { Blackboard } from "../../src/blackboard";

describe("Reflect Analyzer", () => {
  let db: Database;
  let bb: Blackboard;

  beforeEach(() => {
    // Create in-memory database for testing
    bb = new Blackboard(":memory:");
    db = bb.db;
  });

  afterEach(() => {
    bb.close();
  });

  describe("persistLesson", () => {
    it("inserts lesson.created event with searchable summary", () => {
      const lesson: LessonRecord = {
        id: "lesson-test-123",
        project: "test-project",
        workItemId: "work-1",
        phase: "implement",
        category: "testing",
        severity: "high",
        symptom: "Tests failed in CI but passed locally",
        rootCause: "Local environment missing strict mode configuration",
        resolution: "Added strict mode config to local setup",
        constraint: "Always run tests in strict mode before committing",
        tags: ["testing", "ci", "strict-mode"],
        createdAt: "2026-02-25T10:00:00Z",
      };

      persistLesson(db, lesson);

      // Query the events table to verify insertion
      const events = db.query("SELECT * FROM events WHERE event_type = 'lesson.created'").all();
      expect(events.length).toBe(1);

      const event = events[0] as any;
      expect(event.summary).toContain("Tests failed");
      expect(event.summary).toContain("strict mode");
      expect(event.metadata).toBeTruthy();

      const metadata = JSON.parse(event.metadata);
      expect(metadata.id).toBe("lesson-test-123");
      expect(metadata.project).toBe("test-project");
      expect(metadata.constraint).toBe("Always run tests in strict mode before committing");
    });
  });

  describe("queryLessons", () => {
    beforeEach(() => {
      // Insert test lessons
      const lessons: LessonRecord[] = [
        {
          id: "lesson-proj-a-1",
          project: "project-a",
          workItemId: "work-1",
          phase: "implement",
          category: "testing",
          severity: "high",
          symptom: "Test failure symptom for project A",
          rootCause: "Missing test configuration",
          resolution: "Added config file",
          constraint: "Always configure tests properly",
          tags: ["testing"],
          createdAt: "2026-02-25T10:00:00Z",
        },
        {
          id: "lesson-proj-b-1",
          project: "project-b",
          workItemId: "work-2",
          phase: "review",
          category: "types",
          severity: "medium",
          symptom: "Type errors in review for project B",
          rootCause: "Missing type annotations",
          resolution: "Added explicit types",
          constraint: "Always add explicit type annotations",
          tags: ["types"],
          createdAt: "2026-02-25T11:00:00Z",
        },
      ];

      for (const lesson of lessons) {
        persistLesson(db, lesson);
      }
    });

    it("returns all lessons when no filter provided", () => {
      const query: LessonQuery = {};
      const results = queryLessons(db, query);
      expect(results.length).toBe(2);
    });

    it("filters lessons by project", () => {
      const query: LessonQuery = { project: "project-a" };
      const results = queryLessons(db, query);
      expect(results.length).toBe(1);
      expect(results[0].project).toBe("project-a");
    });

    it("filters lessons by category", () => {
      const query: LessonQuery = { category: "testing" };
      const results = queryLessons(db, query);
      expect(results.length).toBe(1);
      expect(results[0].category).toBe("testing");
    });

    it("filters lessons by severity", () => {
      const query: LessonQuery = { severity: "high" };
      const results = queryLessons(db, query);
      expect(results.length).toBe(1);
      expect(results[0].severity).toBe("high");
    });

    it("performs FTS5 search on lesson content", () => {
      const query: LessonQuery = { searchText: "type annotations" };
      const results = queryLessons(db, query);
      expect(results.length).toBe(1);
      expect(results[0].project).toBe("project-b");
    });

    it("respects limit parameter", () => {
      const query: LessonQuery = { limit: 1 };
      const results = queryLessons(db, query);
      expect(results.length).toBe(1);
    });
  });

  describe("isLessonDuplicate", () => {
    beforeEach(() => {
      const existingLesson: LessonRecord = {
        id: "lesson-existing-1",
        project: "test-project",
        workItemId: "work-1",
        phase: "implement",
        category: "testing",
        severity: "high",
        symptom: "Tests fail in CI",
        rootCause: "Missing configuration",
        resolution: "Added config",
        constraint: "Always run type-check before committing code to repository",
        tags: ["testing"],
        createdAt: "2026-02-25T10:00:00Z",
      };
      persistLesson(db, existingLesson);
    });

    it("detects duplicate with 80%+ token overlap", () => {
      const newLesson: LessonRecord = {
        id: "lesson-new-1",
        project: "test-project",
        workItemId: "work-2",
        phase: "implement",
        category: "testing",
        severity: "high",
        symptom: "Different symptom",
        rootCause: "Different cause",
        resolution: "Different fix",
        constraint: "Always run type-check before committing code to the repository",
        tags: ["testing"],
        createdAt: "2026-02-25T11:00:00Z",
      };

      const isDupe = isLessonDuplicate(db, newLesson);
      expect(isDupe).toBe(true);
    });

    it("does not flag unique lesson as duplicate", () => {
      const uniqueLesson: LessonRecord = {
        id: "lesson-unique-1",
        project: "test-project",
        workItemId: "work-3",
        phase: "implement",
        category: "architecture",
        severity: "high",
        symptom: "Different symptom",
        rootCause: "Different cause",
        resolution: "Different fix",
        constraint: "Never use global variables in production code modules",
        tags: ["architecture"],
        createdAt: "2026-02-25T12:00:00Z",
      };

      const isDupe = isLessonDuplicate(db, uniqueLesson);
      expect(isDupe).toBe(false);
    });
  });

  describe("logDuplicateLesson", () => {
    it("inserts lesson.deduplicated event", () => {
      logDuplicateLesson(db, "lesson-existing-1", "Duplicate constraint text");

      const events = db.query("SELECT * FROM events WHERE event_type = 'lesson.deduplicated'").all();
      expect(events.length).toBe(1);

      const event = events[0] as any;
      const metadata = JSON.parse(event.metadata);
      expect(metadata.duplicateOf).toBe("lesson-existing-1");
      expect(metadata.constraint).toBe("Duplicate constraint text");
    });
  });

  describe("gatherReflectInputs", () => {
    beforeEach(() => {
      // Insert mock events for a completed work item
      const now = new Date().toISOString();

      // Spec content (from specify phase)
      db.query(
        `INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary, metadata)
         VALUES (?, 'artifact.created', 'specify-agent', 'work-123', 'work_item', ?, ?)`
      ).run(now, "Specification created", JSON.stringify({
        artifact_type: "spec",
        content: "# Feature Spec\n\nThis feature adds X capability."
      }));

      // Plan content (from plan phase)
      db.query(
        `INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary, metadata)
         VALUES (?, 'artifact.created', 'plan-agent', 'work-123', 'work_item', ?, ?)`
      ).run(now, "Technical plan created", JSON.stringify({
        artifact_type: "plan",
        content: "# Technical Plan\n\n## Architecture\n\nUse pattern X."
      }));

      // Review results
      db.query(
        `INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary, metadata)
         VALUES (?, 'code_review.completed', 'review-agent', 'work-123', 'work_item', ?, ?)`
      ).run(now, "Code review completed", JSON.stringify({
        result: "changes_requested",
        issues: ["Missing type annotations", "Incomplete test coverage"]
      }));

      // Rework history
      db.query(
        `INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary, metadata)
         VALUES (?, 'rework.started', 'rework-agent', 'work-123', 'work_item', ?, ?)`
      ).run(now, "Rework cycle 1 started", JSON.stringify({
        cycle: 1,
        fixing: "type annotations"
      }));

      // PR merge with diff summary
      db.query(
        `INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary, metadata)
         VALUES (?, 'pr.merged', 'merge-agent', 'work-123', 'work_item', ?, ?)`
      ).run(now, "PR #42 merged", JSON.stringify({
        pr_number: 42,
        diff_summary: "+150/-30 lines across 5 files"
      }));
    });

    it("gathers all required inputs from blackboard events", () => {
      const metadata: ReflectMetadata = {
        reflect: true,
        project_id: "test-project",
        implementation_work_item_id: "work-123",
        pr_number: 42,
        pr_url: "https://github.com/test/repo/pull/42",
      };

      const context = gatherReflectInputs(db, metadata);

      expect(context.project).toBe("test-project");
      expect(context.workItemId).toBe("work-123");
      expect(context.prUrl).toBe("https://github.com/test/repo/pull/42");
      expect(context.specContent).toContain("This feature adds X capability");
      expect(context.planContent).toContain("Use pattern X");
      expect(context.reviewResults).toContain("Missing type annotations");
      expect(context.reworkHistory).toContain("type annotations");
      expect(context.diffSummary).toContain("+150/-30 lines");
    });

    it("handles missing events gracefully", () => {
      const metadata: ReflectMetadata = {
        reflect: true,
        project_id: "test-project",
        implementation_work_item_id: "work-999-missing",
        pr_number: 99,
        pr_url: "https://github.com/test/repo/pull/99",
      };

      const context = gatherReflectInputs(db, metadata);

      // Should return empty strings for missing content
      expect(context.specContent).toBe("");
      expect(context.planContent).toBe("");
      expect(context.reviewResults).toBe("");
      expect(context.reworkHistory).toBe("");
      expect(context.diffSummary).toBe("");
    });
  });
});
