import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueJob, GOOGLE_TASKS_SYNC_JOB, syncDedupeKey } from "@scholar/db";
import { ProviderError } from "@scholar/integrations";
import { buildMockGoogleTasksDataset, FixedClock, MockGoogleTasksClient } from "@scholar/testing";
import { runOnce } from "../../apps/worker/src/runner.ts";
import { scheduleDueSyncs } from "../../apps/worker/src/scheduler.ts";
import { createGoogleTasksClientFactory } from "../../apps/worker/src/client-factory.ts";
import {
  createMockIntegration,
  createUser,
  resetDatabase,
  silentLogger,
  testDb,
} from "../support/db-helpers.ts";

const db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDatabase(db));

async function setup() {
  const clock = new FixedClock("2026-11-04T15:00:00.000Z");
  const user = await createUser(db, "r@scholar.example");
  const integration = await createMockIntegration(db, user.id);
  const client = new MockGoogleTasksClient(buildMockGoogleTasksDataset("2026-11-04"), { clock });
  const deps = { db, clock, logger: silentLogger, workerId: "w1", clientFor: async () => client };
  const enqueue = () =>
    enqueueJob(db, {
      userId: user.id,
      kind: GOOGLE_TASKS_SYNC_JOB,
      dedupeKey: syncDedupeKey(integration.id),
      payload: { integrationId: integration.id, trigger: "manual" },
      runAt: clock.now(),
    });
  return { clock, user, integration, client, deps, enqueue };
}

describe("worker runner", () => {
  it("runs a queued sync job to success and releases the dedupe key", async () => {
    const s = await setup();
    const { id } = await s.enqueue();
    expect(await runOnce(s.deps)).toBe("succeeded");
    const job = await db.job.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe("succeeded");
    expect(job.dedupeKey).toBeNull();
    expect((job.result as { listsSeen: number }).listsSeen).toBe(2);
  });

  it("requeues retryable provider failures with backoff, then succeeds (A20)", async () => {
    const s = await setup();
    s.client.injectFailure({
      op: "listTaskLists",
      pageIndex: 0,
      error: new ProviderError("retryable", "http_429", undefined, 1000),
      times: 1,
    });
    const { id } = await s.enqueue();
    expect(await runOnce(s.deps)).toBe("requeued");
    const queued = await db.job.findUniqueOrThrow({ where: { id } });
    expect(queued.status).toBe("queued");
    expect(queued.lastErrorCode).toBe("http_429");
    expect(queued.runAt.getTime()).toBeGreaterThanOrEqual(s.clock.now().getTime() + 1000);
    expect(await runOnce(s.deps)).toBe("idle"); // not yet due
    s.clock.advance(15 * 60_000);
    expect(await runOnce(s.deps)).toBe("succeeded");
  });

  it("marks auth failures as needing reconnect without retry loops", async () => {
    const s = await setup();
    s.client.injectFailure({
      op: "listTaskLists",
      pageIndex: 0,
      error: new ProviderError("auth", "invalid_grant"),
    });
    await s.enqueue();
    expect(await runOnce(s.deps)).toBe("failed");
    const integration = await db.integration.findUniqueOrThrow({ where: { id: s.integration.id } });
    expect(integration.status).toBe("needs_reconnect");
    expect(integration.lastErrorCode).toBe("invalid_grant");
  });

  it("never swaps fixtures and real data in either direction (no silent fallback)", async () => {
    const clock = new FixedClock("2026-11-04T15:00:00.000Z");
    const live = createGoogleTasksClientFactory({ integrationsMode: "live", clock });
    await expect(live({ id: "x", userId: "u", mode: "mock", config: {} })).rejects.toMatchObject({
      code: "mock_integration_in_live_mode",
    });
    // Live mode without credentials/keys configured: refuse rather than serve fixtures.
    await expect(live({ id: "x", userId: "u", mode: "live", config: {} })).rejects.toMatchObject({
      code: "live_google_tasks_not_configured",
    });
    const mock = createGoogleTasksClientFactory({ integrationsMode: "mock", clock });
    await expect(mock({ id: "x", userId: "u", mode: "live", config: {} })).rejects.toMatchObject({
      code: "live_integration_in_mock_mode",
    });
  });

  it("schedules due integrations once, even with repeated scheduler ticks", async () => {
    const s = await setup();
    expect(
      await scheduleDueSyncs({
        db,
        clock: s.clock,
        logger: silentLogger,
        intervalSeconds: 900,
        random: () => 0.5,
      }),
    ).toBe(1);
    expect(
      await scheduleDueSyncs({
        db,
        clock: s.clock,
        logger: silentLogger,
        intervalSeconds: 900,
        random: () => 0.5,
      }),
    ).toBe(0);
    expect(await db.job.count()).toBe(1);
    await runOnce(s.deps);
    // Just synced: not due again until the interval passes.
    expect(
      await scheduleDueSyncs({
        db,
        clock: s.clock,
        logger: silentLogger,
        intervalSeconds: 900,
        random: () => 0.5,
      }),
    ).toBe(0);
    s.clock.advance(16 * 60_000);
    expect(
      await scheduleDueSyncs({
        db,
        clock: s.clock,
        logger: silentLogger,
        intervalSeconds: 900,
        random: () => 0.5,
      }),
    ).toBe(1);
  });

  it("skips users who disabled background sync", async () => {
    const s = await setup();
    await db.preference.update({ where: { userId: s.user.id }, data: { syncEnabled: false } });
    expect(
      await scheduleDueSyncs({ db, clock: s.clock, logger: silentLogger, intervalSeconds: 900 }),
    ).toBe(0);
  });
});
