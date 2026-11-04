/** Pure synchronization policy (SCHOLAR_AI_PLAN.md §4.2). */

export type SyncMode = "full" | "incremental";

/** Re-read every task of a list at least this often; disappearance is only inferred then. */
export const FULL_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Incremental reads start this far before the watermark; duplicates are absorbed by upsert. */
export const INCREMENTAL_OVERLAP_MS = 5 * 60 * 1000;

export interface CursorState {
  watermark: Date | null;
  lastFullReconciliationAt: Date | null;
}

export function chooseSyncMode(cursor: CursorState | null, now: Date): SyncMode {
  if (!cursor || !cursor.watermark || !cursor.lastFullReconciliationAt) return "full";
  return now.getTime() - cursor.lastFullReconciliationAt.getTime() >= FULL_RECONCILE_INTERVAL_MS
    ? "full"
    : "incremental";
}

export function incrementalUpdatedMin(watermark: Date): Date {
  return new Date(watermark.getTime() - INCREMENTAL_OVERLAP_MS);
}

/**
 * Local records missing from a scan. Only a complete full scan can prove disappearance; a
 * timeout, partial page set, or incremental read never deletes anything.
 */
export function disappearedIds(
  localIds: Iterable<string>,
  fetchedIds: ReadonlySet<string>,
  scan: { mode: SyncMode; complete: boolean },
): string[] {
  if (scan.mode !== "full" || !scan.complete) return [];
  const out: string[] = [];
  for (const id of localIds) if (!fetchedIds.has(id)) out.push(id);
  return out;
}

/** Newest provider `updated` timestamp among items, or the previous watermark. */
export function nextWatermark(previous: Date | null, updatedValues: Iterable<string>): Date | null {
  let max = previous ? previous.getTime() : Number.NEGATIVE_INFINITY;
  for (const v of updatedValues) {
    const t = Date.parse(v);
    if (!Number.isNaN(t) && t > max) max = t;
  }
  return Number.isFinite(max) ? new Date(max) : null;
}

/** Scheduled sync due time with symmetric jitter (±10% of the interval). */
export function isScheduledSyncDue(input: {
  now: Date;
  lastAttemptAt: Date | null;
  intervalSeconds: number;
  jitterFraction: number; // in [-1, 1]
}): boolean {
  if (!input.lastAttemptAt) return true;
  const intervalMs = input.intervalSeconds * 1000;
  const jitterMs = intervalMs * 0.1 * Math.max(-1, Math.min(1, input.jitterFraction));
  return input.now.getTime() - input.lastAttemptAt.getTime() >= intervalMs + jitterMs;
}

/** Full-jitter exponential backoff, bounded. `random` in [0, 1). */
export function retryDelayMs(
  attempt: number,
  opts: { baseMs?: number; maxMs?: number; random?: () => number; retryAfterMs?: number } = {},
): number {
  const base = opts.baseMs ?? 5_000;
  const max = opts.maxMs ?? 10 * 60_000;
  const random = opts.random ?? Math.random;
  const ceiling = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const jittered = Math.floor(random() * ceiling);
  // Respect provider guidance (Retry-After) as a floor, still bounded by max.
  return Math.min(max, Math.max(jittered, opts.retryAfterMs ?? 0));
}
