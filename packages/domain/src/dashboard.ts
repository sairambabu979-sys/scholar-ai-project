import { addDays, daysBetween, type DateOnly } from "./dates.ts";

export type DashboardBucket = "overdue" | "today" | "upcoming" | "later" | "no_date" | "completed";

export const UPCOMING_WINDOW_DAYS = 7;
export const COMPLETED_WINDOW_DAYS = 14;

export interface BucketableTask {
  status: "needs_action" | "completed";
  dueDate: DateOnly | null;
  deleted: boolean;
}

/** Classify a task relative to the student's local `today`. Deleted tasks return null. */
export function bucketFor(task: BucketableTask, today: DateOnly): DashboardBucket | null {
  if (task.deleted) return null;
  if (task.status === "completed") return "completed";
  if (!task.dueDate) return "no_date";
  const diff = daysBetween(today, task.dueDate);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff <= UPCOMING_WINDOW_DAYS) return "upcoming";
  return "later";
}

export function groupByBucket<T extends BucketableTask>(
  tasks: T[],
  today: DateOnly,
): Record<DashboardBucket, T[]> {
  const groups: Record<DashboardBucket, T[]> = {
    overdue: [],
    today: [],
    upcoming: [],
    later: [],
    no_date: [],
    completed: [],
  };
  for (const t of tasks) {
    const b = bucketFor(t, today);
    if (b) groups[b].push(t);
  }
  const byDue = (a: T, b: T) =>
    (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31");
  for (const key of Object.keys(groups) as DashboardBucket[]) groups[key].sort(byDue);
  return groups;
}

export function upcomingWindowEnd(today: DateOnly): DateOnly {
  return addDays(today, UPCOMING_WINDOW_DAYS);
}

export type Freshness = "never" | "fresh" | "stale" | "failing";

/**
 * Sync freshness for display. Stale when the last success is older than twice the interval;
 * failing when the most recent attempt failed after the last success.
 */
export function syncFreshness(input: {
  now: Date;
  intervalSeconds: number;
  lastSuccessAt: Date | null;
  lastErrorAt: Date | null;
}): Freshness {
  const { now, intervalSeconds, lastSuccessAt, lastErrorAt } = input;
  if (lastErrorAt && (!lastSuccessAt || lastErrorAt > lastSuccessAt)) return "failing";
  if (!lastSuccessAt) return "never";
  const ageMs = now.getTime() - lastSuccessAt.getTime();
  return ageMs > intervalSeconds * 2 * 1000 ? "stale" : "fresh";
}
