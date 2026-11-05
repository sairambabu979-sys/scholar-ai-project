/**
 * Scheduled synchronization. Polls, it does not promise real-time updates. The shared dedupe
 * key means scheduled and manual syncs for one integration never stack up, and several worker
 * instances running this concurrently still enqueue at most one active job per integration.
 */
import {
  CANVAS_SYNC_JOB,
  enqueueJob,
  GOOGLE_TASKS_SYNC_JOB,
  listIntegrationsForScheduling,
  syncDedupeKey,
  type Db,
} from "@scholar/db";
import { isScheduledSyncDue, type Clock } from "@scholar/domain";
import type { Logger } from "@scholar/security";

export async function scheduleDueSyncs(deps: {
  db: Db;
  clock: Clock;
  logger: Logger;
  intervalSeconds: number;
  random?: () => number;
}): Promise<number> {
  const random = deps.random ?? Math.random;
  const now = deps.clock.now();
  const candidates = await listIntegrationsForScheduling(deps.db);
  let enqueued = 0;
  for (const c of candidates) {
    const due = isScheduledSyncDue({
      now,
      lastAttemptAt: c.lastAttemptAt,
      intervalSeconds: deps.intervalSeconds,
      jitterFraction: random() * 2 - 1,
    });
    if (!due) continue;
    const r = await enqueueJob(deps.db, {
      userId: c.userId,
      kind: c.provider === "canvas" ? CANVAS_SYNC_JOB : GOOGLE_TASKS_SYNC_JOB,
      dedupeKey: syncDedupeKey(c.id),
      payload: { integrationId: c.id, trigger: "scheduled" },
      runAt: now,
    });
    if (!r.deduplicated) enqueued++;
  }
  if (enqueued) deps.logger.info("scheduler.enqueued", { enqueued });
  return enqueued;
}
