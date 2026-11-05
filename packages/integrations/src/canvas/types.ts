import { z } from "zod";

/**
 * Canvas LMS REST shapes (subset), validated at the boundary. Canvas ids are integers in JSON;
 * they are stored as strings. References: developerdocs.instructure.com (Courses, Assignments,
 * Submissions, Pagination, Throttling).
 */
const id = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)])
  .transform(String);
const isoOrNull = z.string().max(64).nullable().optional();

export const canvasCourseSchema = z.object({
  id,
  name: z.string().max(1024).default(""),
  course_code: z.string().max(256).nullable().optional(),
  workflow_state: z.string().max(64).nullable().optional(),
});
export type CanvasCourse = z.infer<typeof canvasCourseSchema>;

export const canvasSubmissionSchema = z.object({
  workflow_state: z.string().max(64).nullable().optional(),
  submitted_at: isoOrNull,
  graded_at: isoOrNull,
  late: z.boolean().nullable().optional(),
  missing: z.boolean().nullable().optional(),
  excused: z.boolean().nullable().optional(),
  attempt: z.number().int().nullable().optional(),
});

export const canvasAssignmentSchema = z.object({
  id,
  course_id: id.optional(),
  name: z.string().max(1024).default(""),
  description: z.string().max(1_000_000).nullable().optional(),
  due_at: isoOrNull,
  unlock_at: isoOrNull,
  lock_at: isoOrNull,
  html_url: z.string().max(2048).nullable().optional(),
  submission_types: z.array(z.string().max(64)).max(20).default([]),
  points_possible: z.number().nullable().optional(),
  rubric: z
    .array(
      z.object({
        description: z.string().max(2000).nullable().optional(),
        points: z.number().nullable().optional(),
      }),
    )
    .max(100)
    .nullable()
    .optional(),
  is_quiz_assignment: z.boolean().nullable().optional(),
  quiz_id: id.nullable().optional(),
  locked_for_user: z.boolean().nullable().optional(),
  workflow_state: z.string().max(64).nullable().optional(),
  /** Present only when `include[]=submission` was honoured for this developer key. */
  submission: canvasSubmissionSchema.nullable().optional(),
});
export type CanvasAssignment = z.infer<typeof canvasAssignmentSchema>;

export const canvasCoursePageSchema = z.array(canvasCourseSchema).max(500);
export const canvasAssignmentPageSchema = z.array(canvasAssignmentSchema).max(500);

export interface Page<T> {
  items: T[];
  /** Opaque continuation (a validated same-origin URL for the live client). */
  next?: string;
}

/**
 * Read-only Canvas client. Implementations: labelled mock (packages/testing) and the live
 * OAuth client. There is no method that submits, answers, messages or modifies anything.
 */
export interface CanvasReadClient {
  readonly mode: "mock" | "live";
  listCourses(next?: string): Promise<Page<unknown>>;
  listAssignments(courseExternalId: string, next?: string): Promise<Page<unknown>>;
}
