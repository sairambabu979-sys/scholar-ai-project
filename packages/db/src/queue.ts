/**
 * Durable PostgreSQL job queue.
 *
 *  - `dedupe_key` is unique while a job is queued or running and released on completion, so a
 *    key has at most one active job (no unbounded duplicates).
 *  - Claims use `FOR UPDATE SKIP LOCKED` and set a lease. Every state change after the claim is
 *    fenced on (locked_by, attempts) so a worker whose lease expired cannot overwrite the
 *    result of the worker that reclaimed the job.
 *  - Expired leases are recovered (requeued or failed when attempts are exhausted).
 */
import type { Prisma } from "./generated/prisma/client.ts";
import type { Db } from "./client.ts";

export type JobStatusValue = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobRecord {
  id: string;
  userId: string;
  kind: string;
  dedupeKey: string | null;
  payload: Record<string, unknown>;
  status: JobStatusValue;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lockedBy: string | null;
  leaseExpiresAt: Date | null;
  cancelRequested: boolean;
}

interface JobRow {
  id: string;
  user_id: string;
  kind: string;
  dedupe_key: string | null;
  payload: unknown;
  status: JobStatusValue;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  locked_by: string | null;
  lease_expires_at: Date | null;
  cancel_requested: boolean;
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    dedupeKey: row.dedupe_key,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    lockedBy: row.locked_by,
    leaseExpiresAt: row.lease_expires_at,
    cancelRequested: row.cancel_requested,
  };
}

const MAX_PAYLOAD_BYTES = 4096;

export interface EnqueueInput {
  userId: string;
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

export interface EnqueueResult {
  id: string;
  deduplicated: boolean;
}

export async function enqueueJob(db: Db, input: EnqueueInput): Promise<EnqueueResult> {
  const payloadJson = JSON.stringify(input.payload);
  if (Buffer.byteLength(payloadJson) > MAX_PAYLOAD_BYTES) {
    throw new Error("Job payload exceeds bound; store references, not content");
  }
  const runAt = input.runAt ?? new Date();
  const maxAttempts = input.maxAttempts ?? 5;
  for (let i = 0; i < 3; i++) {
    const inserted = await db.$queryRaw<Array<{ id: string }>>`
      INSERT INTO jobs (id, user_id, kind, dedupe_key, dedupe_key_origin, payload, status, run_at, max_attempts, updated_at)
      VALUES (gen_random_uuid(), ${input.userId}::uuid, ${input.kind}, ${input.dedupeKey ?? null},
              ${input.dedupeKey ?? null}, ${payloadJson}::jsonb, 'queued', ${runAt}::timestamptz,
              ${maxAttempts}, now())
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id`;
    if (inserted[0]) return { id: inserted[0].id, deduplicated: false };
    // Conflict: an active job already holds the key. It may finish (and release the key)
    // between our insert and this read, in which case we retry the insert.
    const existing = await db.job.findUnique({
      where: { dedupeKey: input.dedupeKey! },
      select: { id: true, userId: true },
    });
    if (existing) {
      if (existing.userId !== input.userId) throw new Error("Dedupe key collision across owners");
      return { id: existing.id, deduplicated: true };
    }
  }
  throw new Error("Could not enqueue job after dedupe retries");
}

export interface ClaimInput {
  workerId: string;
  leaseMs: number;
  now: Date;
  kinds?: string[];
}

export async function claimNextJob(db: Db, input: ClaimInput): Promise<JobRecord | null> {
  const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
  const kinds = input.kinds ?? null;
  const rows = await db.$queryRaw<JobRow[]>`
    UPDATE jobs SET
      status = 'running',
      locked_by = ${input.workerId},
      lease_expires_at = ${leaseUntil}::timestamptz,
      attempts = attempts + 1,
      started_at = COALESCE(started_at, ${input.now}::timestamptz),
      updated_at = now()
    WHERE id = (
      SELECT id FROM jobs
      WHERE status = 'queued'
        AND cancel_requested = false
        AND run_at <= ${input.now}::timestamptz
        AND (${kinds}::text[] IS NULL OR kind = ANY(${kinds}::text[]))
      ORDER BY run_at, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, user_id, kind, dedupe_key, payload, status, attempts, max_attempts, run_at,
              locked_by, lease_expires_at, cancel_requested`;
  return rows[0] ? toRecord(rows[0]) : null;
}

export interface FenceInput {
  jobId: string;
  workerId: string;
  attempt: number;
  now: Date;
}

/** Extend the lease. Returns null if this worker no longer owns the job. */
export async function heartbeatJob(
  db: Db,
  input: FenceInput & { leaseMs: number },
): Promise<{ cancelRequested: boolean } | null> {
  const leaseUntil = new Date(input.now.getTime() + input.leaseMs);
  const rows = await db.$queryRaw<Array<{ cancel_requested: boolean }>>`
    UPDATE jobs SET lease_expires_at = ${leaseUntil}::timestamptz, updated_at = now()
    WHERE id = ${input.jobId}::uuid AND status = 'running'
      AND locked_by = ${input.workerId} AND attempts = ${input.attempt}
    RETURNING cancel_requested`;
  return rows[0] ? { cancelRequested: rows[0].cancel_requested } : null;
}

/** Finish a running job. Returns false if fenced out (another worker owns it now). */
export async function finishJob(
  db: Db,
  input: FenceInput & { status: "succeeded" | "cancelled"; result?: Record<string, unknown> },
): Promise<boolean> {
  const status = input.status;
  const resultJson = JSON.stringify(input.result ?? {});
  const count = await db.$executeRaw`
    UPDATE jobs SET
      status = ${status}::"JobStatus",
      result = ${resultJson}::jsonb,
      dedupe_key = NULL,
      locked_by = NULL,
      lease_expires_at = NULL,
      finished_at = ${input.now}::timestamptz,
      updated_at = now()
    WHERE id = ${input.jobId}::uuid AND status = 'running'
      AND locked_by = ${input.workerId} AND attempts = ${input.attempt}`;
  return count === 1;
}

/**
 * Record a failed attempt. Retryable failures with attempts remaining are requeued after
 * `retryDelayMs`; everything else becomes terminal `failed` and releases the dedupe key.
 */
export async function failJob(
  db: Db,
  input: FenceInput & { errorCode: string; retryable: boolean; retryDelayMs: number },
): Promise<"requeued" | "failed" | "fenced"> {
  const job = await db.job.findUnique({
    where: { id: input.jobId },
    select: {
      attempts: true,
      maxAttempts: true,
      lockedBy: true,
      status: true,
      cancelRequested: true,
    },
  });
  if (
    !job ||
    job.status !== "running" ||
    job.lockedBy !== input.workerId ||
    job.attempts !== input.attempt
  ) {
    return "fenced";
  }
  const canRetry = input.retryable && !job.cancelRequested && job.attempts < job.maxAttempts;
  if (canRetry) {
    const runAt = new Date(input.now.getTime() + input.retryDelayMs);
    const count = await db.$executeRaw`
      UPDATE jobs SET status = 'queued', locked_by = NULL, lease_expires_at = NULL,
        run_at = ${runAt}::timestamptz, last_error_code = ${input.errorCode}, updated_at = now()
      WHERE id = ${input.jobId}::uuid AND status = 'running'
        AND locked_by = ${input.workerId} AND attempts = ${input.attempt}`;
    return count === 1 ? "requeued" : "fenced";
  }
  const count = await db.$executeRaw`
    UPDATE jobs SET status = 'failed', locked_by = NULL, lease_expires_at = NULL,
      dedupe_key = NULL, last_error_code = ${input.errorCode},
      finished_at = ${input.now}::timestamptz, updated_at = now()
    WHERE id = ${input.jobId}::uuid AND status = 'running'
      AND locked_by = ${input.workerId} AND attempts = ${input.attempt}`;
  return count === 1 ? "failed" : "fenced";
}

/** Requeue (or fail, when attempts are exhausted) running jobs whose lease expired. */
export async function recoverExpiredLeases(
  db: Db,
  now: Date,
): Promise<{ requeued: number; failed: number }> {
  const failed = await db.$executeRaw`
    UPDATE jobs SET status = 'failed', locked_by = NULL, lease_expires_at = NULL,
      dedupe_key = NULL, last_error_code = 'lease_expired',
      finished_at = ${now}::timestamptz, updated_at = now()
    WHERE status = 'running' AND lease_expires_at < ${now}::timestamptz
      AND (attempts >= max_attempts OR cancel_requested = true)`;
  const requeued = await db.$executeRaw`
    UPDATE jobs SET status = 'queued', locked_by = NULL, lease_expires_at = NULL,
      last_error_code = 'lease_expired', run_at = ${now}::timestamptz, updated_at = now()
    WHERE status = 'running' AND lease_expires_at < ${now}::timestamptz
      AND attempts < max_attempts AND cancel_requested = false`;
  return { requeued, failed };
}

/**
 * Cancel an owner's jobs that reference an integration: queued jobs become `cancelled`
 * immediately; running jobs get `cancel_requested` and stop at their next checkpoint.
 */
export async function cancelJobsForIntegration(
  db: Db | Prisma.TransactionClient,
  userId: string,
  integrationId: string,
  now: Date,
): Promise<{ cancelled: number; signalled: number }> {
  const cancelled = await db.$executeRaw`
    UPDATE jobs SET status = 'cancelled', dedupe_key = NULL, cancel_requested = true,
      finished_at = ${now}::timestamptz, updated_at = now()
    WHERE user_id = ${userId}::uuid AND status = 'queued'
      AND payload->>'integrationId' = ${integrationId}`;
  const signalled = await db.$executeRaw`
    UPDATE jobs SET cancel_requested = true, updated_at = now()
    WHERE user_id = ${userId}::uuid AND status = 'running'
      AND payload->>'integrationId' = ${integrationId}`;
  return { cancelled, signalled };
}

export async function isJobCancelRequested(db: Db, jobId: string): Promise<boolean> {
  const job = await db.job.findUnique({ where: { id: jobId }, select: { cancelRequested: true } });
  return job?.cancelRequested ?? true;
}
