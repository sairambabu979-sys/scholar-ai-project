import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueJob, GOOGLE_TASKS_SYNC_JOB, syncDedupeKey } from "@scholar/db";
import {
  buildMockGoogleTasksDataset,
  FixedClock,
  MOCK_LIST_COURSEWORK,
  MockGoogleTasksClient,
} from "@scholar/testing";
import { runGoogleTasksSync } from "../../apps/worker/src/handlers/google-tasks-sync.ts";
import { runOnce } from "../../apps/worker/src/runner.ts";
import {
  createMockIntegration,
  createUser,
  resetDatabase,
  silentLogger,
  testDb,
  disconnect,
} from "../support/db-helpers.ts";

const db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDatabase(db));

describe("disconnect during sync (A26)", () => {
  it("stops before the next provider call once the integration is disconnected", async () => {
    const clock = new FixedClock("2026-11-04T15:00:00.000Z");
    const user = await createUser(db, "d@scholar.example");
    const integration = await createMockIntegration(db, user.id);
    const client = new MockGoogleTasksClient(buildMockGoogleTasksDataset("2026-11-04"), {
      clock,
      taskPageSize: 2,
    });
    const deps = { db, clock, logger: silentLogger, clientFor: async () => client };
    const input = { userId: user.id, integrationId: integration.id, trigger: "manual" as const };
    await runGoogleTasksSync(deps, input);
    await db.taskList.updateMany({
      where: { externalId: MOCK_LIST_COURSEWORK },
      data: { selected: true },
    });

    // Disconnect while the first task page is being served.
    const original = client.listTasks.bind(client);
    let served = 0;
    client.listTasks = async (...args) => {
      const page = await original(...args);
      if (++served === 1) {
        await disconnect(db, user.id, integration.id, false, clock.now());
      }
      return page;
    };
    const taskCalls = () => client.calls.filter((c) => c.op === "listTasks").length;
    const before = taskCalls();
    const r = await runGoogleTasksSync(deps, input);
    expect(r.status).toBe("cancelled");
    expect(taskCalls() - before).toBe(1); // no provider call after the disconnect
    expect(await db.task.count()).toBe(0); // staged pages were never committed
    const run = await db.syncRun.findUniqueOrThrow({ where: { id: r.syncRunId } });
    expect(run.status).toBe("cancelled");
    expect(run.safeErrorCode).toBe("integration_inactive");
  });

  it("cancels queued jobs, and optionally deletes cached data", async () => {
    const clock = new FixedClock("2026-11-04T15:00:00.000Z");
    const user = await createUser(db, "d2@scholar.example");
    const integration = await createMockIntegration(db, user.id);
    const client = new MockGoogleTasksClient(buildMockGoogleTasksDataset("2026-11-04"), { clock });
    const deps = { db, clock, logger: silentLogger, clientFor: async () => client };
    const input = { userId: user.id, integrationId: integration.id, trigger: "manual" as const };
    await runGoogleTasksSync(deps, input);
    await db.taskList.updateMany({ data: { selected: true } });
    await runGoogleTasksSync(deps, input);
    expect(await db.task.count()).toBe(15);

    const job = await enqueueJob(db, {
      userId: user.id,
      kind: GOOGLE_TASKS_SYNC_JOB,
      dedupeKey: syncDedupeKey(integration.id),
      payload: { integrationId: integration.id, trigger: "manual" },
      runAt: clock.now(),
    });
    const r = await disconnect(db, user.id, integration.id, true, clock.now());
    expect(r?.jobs.cancelled).toBe(1);
    expect(r?.revocation).toBe("not_applicable");
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("cancelled");
    expect(await db.task.count()).toBe(0);
    expect(await db.taskList.count()).toBe(0);
    const outcome = await runOnce({
      db,
      clock,
      logger: silentLogger,
      workerId: "w",
      clientFor: deps.clientFor,
    });
    expect(outcome).toBe("idle");
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { action: "integration.disconnected" },
    });
    expect(JSON.stringify(audit.metadata)).not.toMatch(/token/i);
  });
});
