/**
 * Job runner: claims jobs with leases, heartbeats while they run, and records outcomes with
 * fencing. Retryable provider failures are retried with bounded full-jitter backoff.
 */
import {
  claimNextJob,
  failJob,
  finishJob,
  GOOGLE_TASKS_SYNC_JOB,
  heartbeatJob,
  recoverExpiredLeases,
  type Db,
  type JobRecord,
} from "@scholar/db";
import { retryDelayMs, type Clock } from "@scholar/domain";
import { isProviderError } from "@scholar/integrations";
import type { Logger } from "@scholar/security";
import { runGoogleTasksSync, type SyncDeps } from "./handlers/google-tasks-sync.ts";

export interface RunnerDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  workerId: string;
  clientFor: SyncDeps["clientFor"];
  leaseMs?: number;
}

export type JobOutcome = "succeeded" | "cancelled" | "requeued" | "failed" | "fenced" | "idle";

const LEASE_MS = 60_000;

async function dispatch(
  deps: RunnerDeps,
  job: JobRecord,
  isCancelled: () => Promise<boolean>,
): Promise<{ status: "succeeded" | "cancelled"; result: Record<string, unknown> }> {
  switch (job.kind) {
    case GOOGLE_TASKS_SYNC_JOB: {
      const p = job.payload as { integrationId?: string; trigger?: string };
      if (!p.integrationId) throw new Error("sync job missing integrationId");
      const trigger = p.trigger === "scheduled" || p.trigger === "initial" ? p.trigger : "manual";
      const summary = await runGoogleTasksSync(
        {
          db: deps.db,
          clock: deps.clock,
          logger: deps.logger,
          clientFor: deps.clientFor,
          isCancelled,
        },
        { userId: job.userId, integrationId: p.integrationId, trigger, jobId: job.id },
      );
      const { status, ...rest } = summary;
      return { status, result: rest as unknown as Record<string, unknown> };
    }
    default:
      throw new Error(`unknown job kind ${job.kind}`);
  }
}

/** Claim and run at most one job. Returns what happened (for tests and loop pacing). */
export async function runOnce(deps: RunnerDeps): Promise<JobOutcome> {
  const leaseMs = deps.leaseMs ?? LEASE_MS;
  const job = await claimNextJob(deps.db, {
    workerId: deps.workerId,
    leaseMs,
    now: deps.clock.now(),
  });
  if (!job) return "idle";
  const log = deps.logger.child({ jobId: job.id, kind: job.kind, attempt: job.attempts });
  const fence = { jobId: job.id, workerId: deps.workerId, attempt: job.attempts };

  let lostLease = false;
  let cancelRequested = job.cancelRequested;
  const beat = setInterval(
    () => {
      heartbeatJob(deps.db, { ...fence, now: deps.clock.now(), leaseMs })
        .then((r) => {
          if (!r) lostLease = true;
          else cancelRequested = r.cancelRequested;
        })
        .catch(() => undefined);
    },
    Math.max(1_000, Math.floor(leaseMs / 3)),
  );

  const isCancelled = async () => {
    if (lostLease || cancelRequested) return true;
    const r = await heartbeatJob(deps.db, { ...fence, now: deps.clock.now(), leaseMs });
    if (!r) {
      lostLease = true;
      return true;
    }
    cancelRequested = r.cancelRequested;
    return cancelRequested;
  };

  try {
    const { status, result } = await dispatch(deps, job, isCancelled);
    const ok = await finishJob(deps.db, { ...fence, now: deps.clock.now(), status, result });
    if (!ok) {
      log.warn("job.fenced", {});
      return "fenced";
    }
    log.info("job.finished", { status });
    return status;
  } catch (error) {
    const retryable = isProviderError(error) && error.retryable;
    const errorCode = isProviderError(error) ? error.code : "internal_error";
    const delay = retryDelayMs(job.attempts, {
      retryAfterMs: isProviderError(error) ? error.retryAfterMs : undefined,
    });
    const outcome = await failJob(deps.db, {
      ...fence,
      now: deps.clock.now(),
      errorCode,
      retryable,
      retryDelayMs: delay,
    });
    log.warn("job.failed", {
      errorCode,
      retryable,
      outcome,
      retryInMs: outcome === "requeued" ? delay : undefined,
    });
    return outcome;
  } finally {
    clearInterval(beat);
  }
}

export async function recoverLeases(deps: Pick<RunnerDeps, "db" | "clock" | "logger">) {
  const r = await recoverExpiredLeases(deps.db, deps.clock.now());
  if (r.requeued || r.failed) deps.logger.warn("jobs.lease_recovered", r);
  return r;
}
