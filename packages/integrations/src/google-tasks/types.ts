import { z } from "zod";

/**
 * Google Tasks REST v1 resource shapes (subset used by Scholar AI), validated at the boundary.
 * Reference: https://developers.google.com/workspace/tasks/reference/rest/v1/tasks
 */
export const googleTaskListSchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().max(4096).default(""),
  updated: z.string().optional(),
  etag: z.string().optional(),
});
export type GoogleTaskList = z.infer<typeof googleTaskListSchema>;

export const googleTaskSchema = z.object({
  id: z.string().min(1).max(256),
  title: z.string().max(65_536).optional(),
  notes: z.string().max(65_536).optional(),
  status: z.enum(["needsAction", "completed"]),
  /** RFC3339 timestamp whose date part is the due DATE; time-of-day is not exposed. */
  due: z.string().optional(),
  completed: z.string().optional(),
  parent: z.string().optional(),
  position: z.string().optional(),
  hidden: z.boolean().optional(),
  deleted: z.boolean().optional(),
  updated: z.string(),
  etag: z.string().optional(),
  webViewLink: z.string().optional(),
});
export type GoogleTask = z.infer<typeof googleTaskSchema>;

export const googleTaskListPageSchema = z.object({
  items: z.array(googleTaskListSchema).default([]),
  nextPageToken: z.string().optional(),
});
export type GoogleTaskListPage = z.infer<typeof googleTaskListPageSchema>;

export const googleTaskPageSchema = z.object({
  items: z.array(googleTaskSchema).default([]),
  nextPageToken: z.string().optional(),
});
export type GoogleTaskPage = z.infer<typeof googleTaskPageSchema>;

export interface ListTasksOptions {
  pageToken?: string;
  /** Lower bound on last modification time (RFC3339). */
  updatedMin?: string;
  showCompleted: boolean;
  showHidden: boolean;
  showDeleted: boolean;
  maxResults?: number;
}

/**
 * Read-only Google Tasks client. Implementations: the labelled mock (packages/testing) now,
 * the live OAuth client in Phase 2. There is intentionally no write method here; task
 * completion (milestone M5) lives in a separate executor gated by approvals.
 */
export interface GoogleTasksReadClient {
  readonly mode: "mock" | "live";
  listTaskLists(opts?: { pageToken?: string }): Promise<GoogleTaskListPage>;
  listTasks(taskListId: string, opts: ListTasksOptions): Promise<GoogleTaskPage>;
}
