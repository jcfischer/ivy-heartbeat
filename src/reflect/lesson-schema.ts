/**
 * Zod validation schema for LessonRecord
 */

import { z } from "zod";

/**
 * Zod schema for validating lesson records at runtime
 *
 * Enforces:
 * - Required fields are present
 * - Enums match allowed values
 * - String fields meet minimum length (10 chars for text fields)
 * - DateTime format is valid ISO 8601
 */
export const LessonRecordSchema = z.object({
  id: z.string(),
  project: z.string().min(1),
  workItemId: z.string().min(1),
  phase: z.enum(["implement", "review", "rework", "merge-fix"]),
  category: z.string().min(1),
  severity: z.enum(["low", "medium", "high"]),
  symptom: z.string().min(10),
  rootCause: z.string().min(10),
  resolution: z.string().min(10),
  constraint: z.string().min(10),
  tags: z.array(z.string()),
  createdAt: z.string().datetime(),
});

/**
 * Inferred TypeScript type from the Zod schema
 */
export type LessonRecord = z.infer<typeof LessonRecordSchema>;
