import { describe, it, expect } from "bun:test";
import { LessonRecordSchema } from "../../src/reflect/lesson-schema";
import type { LessonRecord } from "../../src/reflect/types";

describe("LessonRecord Schema Validation", () => {
  const validLesson: LessonRecord = {
    id: "lesson-ivy-heartbeat-1234567890",
    project: "ivy-heartbeat",
    workItemId: "work-item-456",
    phase: "implement",
    category: "testing",
    severity: "high",
    symptom: "TypeScript strict mode errors not caught until CI pipeline ran",
    rootCause: "Local development skipped the type-check step before committing changes",
    resolution: "Added pre-commit hook running tsc --noEmit to catch errors early",
    constraint: "Always run type-check before committing code to repository",
    tags: ["typescript", "type-check", "ci", "pre-commit"],
    createdAt: "2026-02-25T10:30:00Z",
  };

  it("validates a valid lesson record", () => {
    const result = LessonRecordSchema.safeParse(validLesson);
    expect(result.success).toBe(true);
  });

  it("rejects lesson with missing id", () => {
    const { id, ...lessonWithoutId } = validLesson;
    const result = LessonRecordSchema.safeParse(lessonWithoutId);
    expect(result.success).toBe(false);
  });

  it("rejects lesson with empty project", () => {
    const lesson = { ...validLesson, project: "" };
    const result = LessonRecordSchema.safeParse(lesson);
    expect(result.success).toBe(false);
  });

  it("rejects lesson with invalid phase", () => {
    const lesson = { ...validLesson, phase: "invalid-phase" };
    const result = LessonRecordSchema.safeParse(lesson);
    expect(result.success).toBe(false);
  });

  it("rejects lesson with invalid severity", () => {
    const lesson = { ...validLesson, severity: "critical" };
    const result = LessonRecordSchema.safeParse(lesson);
    expect(result.success).toBe(false);
  });

  it("rejects lesson with symptom shorter than 10 characters", () => {
    const lesson = { ...validLesson, symptom: "Too short" };
    const result = LessonRecordSchema.safeParse(lesson);
    expect(result.success).toBe(false);
  });

  it("rejects lesson with rootCause shorter than 10 characters", () => {
    const lesson = { ...validLesson, rootCause: "Too short" };
    const result = LessonRecordSchema.safeParse(lesson);
    expect(result.success).toBe(false);
  });

  it("rejects lesson with resolution shorter than 10 characters", () => {
    const lesson = { ...validLesson, resolution: "Too short" };
    const result = LessonRecordSchema.safeParse(lesson);
    expect(result.success).toBe(false);
  });

  it("rejects lesson with constraint shorter than 10 characters", () => {
    const lesson = { ...validLesson, constraint: "Too short" };
    const result = LessonRecordSchema.safeParse(lesson);
    expect(result.success).toBe(false);
  });

  it("rejects lesson with invalid datetime format", () => {
    const lesson = { ...validLesson, createdAt: "not-a-date" };
    const result = LessonRecordSchema.safeParse(lesson);
    expect(result.success).toBe(false);
  });

  it("accepts all valid phase values", () => {
    const phases: Array<LessonRecord["phase"]> = ["implement", "review", "rework", "merge-fix"];

    for (const phase of phases) {
      const lesson = { ...validLesson, phase };
      const result = LessonRecordSchema.safeParse(lesson);
      expect(result.success).toBe(true);
    }
  });

  it("accepts all valid severity values", () => {
    const severities: Array<LessonRecord["severity"]> = ["low", "medium", "high"];

    for (const severity of severities) {
      const lesson = { ...validLesson, severity };
      const result = LessonRecordSchema.safeParse(lesson);
      expect(result.success).toBe(true);
    }
  });
});
