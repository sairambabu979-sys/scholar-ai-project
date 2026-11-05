/**
 * Effective academic deadline with provenance (SCHOLAR_AI_PLAN.md §7 invariants):
 * explicit local override → student-effective Canvas due instant → Google date-only due date.
 * Provider values are never overwritten; every source stays visible.
 */
import { todayInTimeZone, type DateOnly } from "./dates.ts";

export type DeadlineSource = "manual" | "canvas" | "google";

export interface DeadlineInputs {
  manualDueAt?: Date | null;
  manualDueDate?: DateOnly | null;
  canvasDueAt?: Date | null;
  googleDueDate?: DateOnly | null;
}

export interface EffectiveDeadline {
  source: DeadlineSource;
  /** Calendar date in the student's timezone (used for dashboard buckets). */
  date: DateOnly;
  /** Exact instant when the source has one (Canvas or a manual time). */
  instant: Date | null;
  /** Other sources that disagree on the calendar date, for display. */
  conflicts: Array<{ source: DeadlineSource; date: DateOnly }>;
}

export function effectiveDeadline(
  inputs: DeadlineInputs,
  timeZone: string,
): EffectiveDeadline | null {
  const candidates: Array<{ source: DeadlineSource; date: DateOnly; instant: Date | null }> = [];
  if (inputs.manualDueAt)
    candidates.push({
      source: "manual",
      date: todayInTimeZone(inputs.manualDueAt, timeZone),
      instant: inputs.manualDueAt,
    });
  else if (inputs.manualDueDate)
    candidates.push({ source: "manual", date: inputs.manualDueDate, instant: null });
  if (inputs.canvasDueAt)
    candidates.push({
      source: "canvas",
      date: todayInTimeZone(inputs.canvasDueAt, timeZone),
      instant: inputs.canvasDueAt,
    });
  if (inputs.googleDueDate)
    candidates.push({ source: "google", date: inputs.googleDueDate, instant: null });
  const winner = candidates[0];
  if (!winner) return null;
  return {
    ...winner,
    conflicts: candidates
      .slice(1)
      .filter((c) => c.date !== winner.date)
      .map((c) => ({ source: c.source, date: c.date })),
  };
}

export const DEADLINE_SOURCE_LABEL: Record<DeadlineSource, string> = {
  manual: "your override",
  canvas: "Canvas",
  google: "Google Tasks",
};
