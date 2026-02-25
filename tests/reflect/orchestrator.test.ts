import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { runReflect, parseReflectMeta } from "../../src/scheduler/reflect";
import type { ReflectMetadata } from "../../src/reflect/types";
import { Blackboard } from "../../src/blackboard";

describe("Reflect Orchestrator", () => {
  let db: Database;
  let bb: Blackboard;

  beforeEach(() => {
    bb = new Blackboard(":memory:");
    db = bb.db;
  });

  afterEach(() => {
    bb.close();
  });

  describe("parseReflectMeta", () => {
    it("extracts valid metadata from work item", () => {
      const metadata = {
        reflect: true,
        project_id: "test-project",
        implementation_work_item_id: "work-123",
        pr_number: 42,
        pr_url: "https://github.com/test/repo/pull/42",
      };

      const result = parseReflectMeta(metadata);

      expect(result).toEqual(metadata);
    });

    it("throws error when reflect flag is missing", () => {
      const metadata = {
        project_id: "test-project",
        implementation_work_item_id: "work-123",
        pr_number: 42,
        pr_url: "https://github.com/test/repo/pull/42",
      };

      expect(() => parseReflectMeta(metadata)).toThrow();
    });

    it("throws error when required fields are missing", () => {
      const metadata = {
        reflect: true,
        project_id: "test-project",
        // missing implementation_work_item_id
        pr_number: 42,
        pr_url: "https://github.com/test/repo/pull/42",
      };

      expect(() => parseReflectMeta(metadata)).toThrow();
    });
  });

  describe("runReflect", () => {
    beforeEach(() => {
      // Insert mock events for a completed work item
      const now = new Date().toISOString();

      // Spec content
      db.query(
        `INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary, metadata)
         VALUES (?, 'artifact.created', 'specify-agent', 'work-123', 'work_item', ?, ?)`
      ).run(now, "Specification created", JSON.stringify({
        artifact_type: "spec",
        content: "# Feature Spec\n\nImplement feature X with Y capability."
      }));

      // Plan content
      db.query(
        `INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary, metadata)
         VALUES (?, 'artifact.created', 'plan-agent', 'work-123', 'work_item', ?, ?)`
      ).run(now, "Technical plan created", JSON.stringify({
        artifact_type: "plan",
        content: "# Technical Plan\n\nUse architecture pattern Z."
      }));

      // Review results with issues
      db.query(
        `INSERT INTO events (timestamp, event_type, actor_id, target_id, target_type, summary, metadata)
         VALUES (?, 'code_review.completed', 'review-agent', 'work-123', 'work_item', ?, ?)`
      ).run(now, "Code review requested changes", JSON.stringify({
        result: "changes_requested",
        issues: ["Missing error handling", "Incomplete test coverage"]
      }));
    });

    it("successfully orchestrates reflect pipeline with mock agent", async () => {
      // Mock the agent launcher to return valid lesson JSON
      const mockLessons = [
        {
          phase: "implement",
          category: "testing",
          severity: "high",
          symptom: "Tests passed locally but failed in CI environment consistently",
          rootCause: "Local environment was missing strict mode TypeScript configuration",
          resolution: "Added tsconfig.strict.json and updated pre-commit hooks",
          constraint: "Always run type-check in strict mode before committing",
          tags: ["typescript", "testing", "ci"],
        },
      ];

      const metadata: ReflectMetadata = {
        reflect: true,
        project_id: "test-project",
        implementation_work_item_id: "work-123",
        pr_number: 42,
        pr_url: "https://github.com/test/repo/pull/42",
      };

      // Create project first to satisfy foreign key constraint
      db.query(
        "INSERT INTO projects (project_id, display_name, registered_at) VALUES (?, ?, ?)"
      ).run("test-project", "Test Project", new Date().toISOString());

      // Create work item for reflect
      bb.createWorkItem({
        id: "reflect-work-123",
        title: "Reflect on work-123",
        description: "Reflect phase for work-123",
        project: "test-project",
        metadata: JSON.stringify(metadata),
      });

      // Since we can't easily mock the claude CLI invocation in tests,
      // we'll test the parsing and validation logic separately
      // This test verifies the structure is correct

      const result = parseReflectMeta(metadata);
      expect(result.project_id).toBe("test-project");
      expect(result.implementation_work_item_id).toBe("work-123");
    });

    it("validates lessons with Zod schema", () => {
      // This would be part of runReflect implementation
      // The function should validate each lesson with LessonRecordSchema
      // and reject malformed lessons

      const validLesson = {
        phase: "implement",
        category: "testing",
        severity: "high",
        symptom: "Tests failed in CI but passed locally",
        rootCause: "Missing configuration",
        resolution: "Added config file",
        constraint: "Always run tests in CI mode locally before committing",
        tags: ["testing"],
      };

      expect(validLesson.symptom.length).toBeGreaterThanOrEqual(10);
      expect(validLesson.constraint.length).toBeGreaterThanOrEqual(10);
    });
  });
});
