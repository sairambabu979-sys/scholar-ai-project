import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  cancelJobsForIntegration,
  claimNextJob,
  enqueueJob,
  failJob,
  finishJob,
  heartbeatJob,
  recoverExpiredLeases,
} from "@scholar/db";
import { createUser, resetDatabase, testDb } from "../support/db-helpers.ts";

const db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDatabase(db));

const now = new Date("2026-11-04T15:00:00.000Z");
const later = (ms: number) => new Date(now.getTime() + ms);

describe("durable job queue", () => {
  it("deduplicates active jobs per key, and allows a new one after completion", async () => {
    const u = await createUser(db, "q@scholar.example");
    const a = await enqueueJob(db, {
      userId: u.id,
      kind: "k",
      dedupeKey: "sync:1",
      payload: {},
      runAt: now,
    });
    const b = await enqueueJob(db, {
      userId: u.id,
      kind: "k",
      dedupeKey: "sync:1",
      payload: {},
      runAt: now,
    });
    expect(b).toEqual({ id: a.id, deduplicated: true });
    const parallel = await Promise.all(
      Array.from({ length: 10 }, () =>
        enqueueJob(db, { userId: u.id, kind: "k", dedupeKey: "sync:1", payload: {} }),
      ),
    );
    expect(new Set(parallel.map((p) => p.id))).toEqual(new Set([a.id]));

    const job = (await claimNextJob(db, { workerId: "w1", leaseMs: 60_000, now }))!;
    expect(
      await finishJob(db, {
        jobId: job.id,
        workerId: "w1",
        attempt: job.attempts,
        now,
        status: "succeeded",
      }),
    ).toBe(true);
    const c = await enqueueJob(db, {
      userId: u.id,
      kind: "k",
      dedupeKey: "sync:1",
      payload: {},
      runAt: now,
    });
    expect(c.deduplicated).toBe(false);
    expect(c.id).not.toBe(a.id);
  });

  it("rejects oversized payloads (references only, never content)", async () => {
    const u = await createUser(db, "q2@scholar.example");
    await expect(
      enqueueJob(db, { userId: u.id, kind: "k", payload: { blob: "x".repeat(5000) } }),
    ).rejects.toThrow(/payload/);
  });

  it("lets concurrent workers claim each job exactly once (SKIP LOCKED)", async () => {
    const u = await createUser(db, "q3@scholar.example");
    for (let i = 0; i < 20; i++)
      await enqueueJob(db, { userId: u.id, kind: "k", payload: { i }, runAt: now });
    const claims = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        claimNextJob(db, { workerId: `w${i}`, leaseMs: 60_000, now }),
      ),
    );
    const ids = claims.filter(Boolean).map((j) => j!.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  it("does not claim jobs scheduled in the future", async () => {
    const u = await createUser(db, "q4@scholar.example");
    await enqueueJob(db, { userId: u.id, kind: "k", payload: {}, runAt: later(60_000) });
    expect(await claimNextJob(db, { workerId: "w", leaseMs: 1000, now })).toBeNull();
  });

  it("recovers expired leases and fences out the stale worker (A20)", async () => {
    const u = await createUser(db, "q5@scholar.example");
    await enqueueJob(db, { userId: u.id, kind: "k", dedupeKey: "d", payload: {}, runAt: now });
    const first = (await claimNextJob(db, { workerId: "crashed", leaseMs: 1_000, now }))!;
    // Worker "crashed" stops heartbeating; the lease expires.
    const recovered = await recoverExpiredLeases(db, later(5_000));
    expect(recovered.requeued).toBe(1);
    const second = (await claimNextJob(db, {
      workerId: "healthy",
      leaseMs: 60_000,
      now: later(5_000),
    }))!;
    expect(second.id).toBe(first.id);
    expect(second.attempts).toBe(2);

    // The stale worker wakes up: every state change it attempts is fenced.
    expect(
      await heartbeatJob(db, {
        jobId: first.id,
        workerId: "crashed",
        attempt: 1,
        now: later(6_000),
        leaseMs: 1000,
      }),
    ).toBeNull();
    expect(
      await finishJob(db, {
        jobId: first.id,
        workerId: "crashed",
        attempt: 1,
        now: later(6_000),
        status: "succeeded",
      }),
    ).toBe(false);
    expect(
      await failJob(db, {
        jobId: first.id,
        workerId: "crashed",
        attempt: 1,
        now: later(6_000),
        errorCode: "x",
        retryable: false,
        retryDelayMs: 0,
      }),
    ).toBe("fenced");
    expect(
      await finishJob(db, {
        jobId: second.id,
        workerId: "healthy",
        attempt: 2,
        now: later(7_000),
        status: "succeeded",
      }),
    ).toBe(true);
  });

  it("retries retryable failures until attempts are exhausted, then fails terminally", async () => {
    const u = await createUser(db, "q6@scholar.example");
    await enqueueJob(db, {
      userId: u.id,
      kind: "k",
      dedupeKey: "r",
      payload: {},
      runAt: now,
      maxAttempts: 2,
    });
    let t = now;
    const j1 = (await claimNextJob(db, { workerId: "w", leaseMs: 60_000, now: t }))!;
    expect(
      await failJob(db, {
        jobId: j1.id,
        workerId: "w",
        attempt: 1,
        now: t,
        errorCode: "http_503",
        retryable: true,
        retryDelayMs: 1000,
      }),
    ).toBe("requeued");
    expect(await claimNextJob(db, { workerId: "w", leaseMs: 60_000, now: t })).toBeNull(); // backoff
    t = later(2_000);
    const j2 = (await claimNextJob(db, { workerId: "w", leaseMs: 60_000, now: t }))!;
    expect(
      await failJob(db, {
        jobId: j2.id,
        workerId: "w",
        attempt: 2,
        now: t,
        errorCode: "http_503",
        retryable: true,
        retryDelayMs: 1000,
      }),
    ).toBe("failed");
    const row = await db.job.findUniqueOrThrow({ where: { id: j1.id } });
    expect(row.status).toBe("failed");
    expect(row.dedupeKey).toBeNull();
    expect(row.lastErrorCode).toBe("http_503");
  });

  it("non-retryable failures fail immediately", async () => {
    const u = await createUser(db, "q7@scholar.example");
    await enqueueJob(db, { userId: u.id, kind: "k", payload: {}, runAt: now });
    const j = (await claimNextJob(db, { workerId: "w", leaseMs: 60_000, now }))!;
    expect(
      await failJob(db, {
        jobId: j.id,
        workerId: "w",
        attempt: 1,
        now,
        errorCode: "fatal",
        retryable: false,
        retryDelayMs: 0,
      }),
    ).toBe("failed");
  });

  it("cancels queued jobs and signals running jobs for an integration", async () => {
    const u = await createUser(db, "q8@scholar.example");
    const integrationId = "11111111-1111-4111-8111-111111111111";
    await enqueueJob(db, { userId: u.id, kind: "k", payload: { integrationId }, runAt: now });
    await enqueueJob(db, { userId: u.id, kind: "k", payload: { integrationId }, runAt: now });
    const running = (await claimNextJob(db, { workerId: "w", leaseMs: 60_000, now }))!;
    const r = await cancelJobsForIntegration(db, u.id, integrationId, now);
    expect(r).toEqual({ cancelled: 1, signalled: 1 });
    expect(
      (
        await heartbeatJob(db, {
          jobId: running.id,
          workerId: "w",
          attempt: 1,
          now,
          leaseMs: 60_000,
        })
      )?.cancelRequested,
    ).toBe(true);
    expect(await claimNextJob(db, { workerId: "w2", leaseMs: 60_000, now })).toBeNull();
  });
});
