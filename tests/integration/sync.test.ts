import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { dbDateToDateOnly } from "@scholar/domain";
import { ProviderError } from "@scholar/integrations";
import {
  buildMockGoogleTasksDataset,
  FixedClock,
  MOCK_LIST_COURSEWORK,
  MOCK_LIST_PERSONAL,
  MockGoogleTasksClient,
} from "@scholar/testing";
import { runGoogleTasksSync } from "../../apps/worker/src/handlers/google-tasks-sync.ts";
import {
  createMockIntegration,
  createUser,
  resetDatabase,
  silentLogger,
  testDb,
} from "../support/db-helpers.ts";

const db = testDb();
afterAll(() => db.$disconnect());

async function setup(opts: { taskPageSize?: number } = {}) {
  const clock = new FixedClock("2026-11-04T15:00:00.000Z");
  const user = await createUser(db, "student@scholar.example", "America/New_York");
  const integration = await createMockIntegration(db, user.id);
  const client = new MockGoogleTasksClient(buildMockGoogleTasksDataset("2026-11-04"), {
    clock,
    taskPageSize: opts.taskPageSize ?? 5,
  });
  const deps = { db, clock, logger: silentLogger, clientFor: async () => client };
  const input = { userId: user.id, integrationId: integration.id, trigger: "manual" as const };
  const sync = () => runGoogleTasksSync(deps, input);
  const select = async (...externalIds: string[]) => {
    await db.taskList.updateMany({
      where: { integrationId: integration.id },
      data: { selected: false },
    });
    await db.taskList.updateMany({
      where: { integrationId: integration.id, externalId: { in: externalIds } },
      data: { selected: true },
    });
  };
  const tasks = () =>
    db.task.findMany({ where: { integrationId: integration.id }, orderBy: { externalId: "asc" } });
  return { clock, user, integration, client, sync, select, tasks };
}

beforeEach(() => resetDatabase(db));

describe("Google Tasks sync (mock adapter)", () => {
  it("discovers lists first and imports nothing until lists are selected", async () => {
    const s = await setup();
    const r = await s.sync();
    expect(r.listsSeen).toBe(2);
    expect(r.tasksFetched).toBe(0);
    expect(await s.tasks()).toHaveLength(0);
    const lists = await db.taskList.findMany({ where: { integrationId: s.integration.id } });
    expect(lists.every((l) => !l.selected)).toBe(true);
  });

  it("imports every page of selected lists only, including completed/hidden/deleted (A05)", async () => {
    const s = await setup();
    await s.sync();
    await s.select(MOCK_LIST_COURSEWORK);
    const r = await s.sync();
    expect(r.status).toBe("succeeded");
    expect(r.pagesFetched).toBe(2 + 3); // 2 list pages + ceil(12/5) task pages
    const tasks = await s.tasks();
    expect(tasks).toHaveLength(12);
    expect(tasks.find((t) => t.externalId === "mock-task-009")?.hidden).toBe(true);
    expect(tasks.find((t) => t.externalId === "mock-task-010")?.deleted).toBe(true);
    expect(tasks.find((t) => t.externalId === "mock-task-008")?.status).toBe("completed");
    expect(tasks.some((t) => t.externalId === "mock-task-013")).toBe(false); // personal list
  });

  it("keeps date-only due values unchanged in storage (A04)", async () => {
    const s = await setup();
    await s.sync();
    await s.select(MOCK_LIST_COURSEWORK);
    await s.sync();
    const t2 = (await s.tasks()).find((t) => t.externalId === "mock-task-002")!;
    expect(dbDateToDateOnly(t2.dueDate!)).toBe("2026-11-06");
    const raw = await db.$queryRaw<Array<{ d: string }>>`
      SELECT due_date::text AS d FROM tasks WHERE id = ${t2.id}::uuid`;
    expect(raw[0]!.d).toBe("2026-11-06");
  });

  it("repeat syncs create no duplicates and skip unchanged rows", async () => {
    const s = await setup();
    await s.sync();
    await s.select(MOCK_LIST_COURSEWORK, MOCK_LIST_PERSONAL);
    await s.sync();
    s.clock.advance(60_000);
    const second = await s.sync();
    expect(second.tasksUpserted).toBe(0);
    expect(await db.task.count()).toBe(15);
    const dupes = await db.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM (SELECT external_id FROM tasks GROUP BY integration_id, external_id HAVING count(*) > 1) d`;
    expect(Number(dupes[0]!.n)).toBe(0);
  });

  it("applies incremental changes and tombstones", async () => {
    const s = await setup();
    await s.sync();
    await s.select(MOCK_LIST_COURSEWORK);
    await s.sync();
    s.clock.advance(10 * 60_000);
    s.client.upsertTask(MOCK_LIST_COURSEWORK, {
      id: "mock-task-002",
      title: "MATH 221 — Problem set 7 (revised)",
    });
    s.client.upsertTask(MOCK_LIST_COURSEWORK, {
      id: "mock-task-new",
      title: "New synthetic task",
      status: "needsAction",
    });
    s.client.deleteTask(MOCK_LIST_COURSEWORK, "mock-task-003");
    s.clock.advance(60_000);
    const r = await s.sync();
    expect(r.modes[MOCK_LIST_COURSEWORK]).toBe("incremental");
    // The overlap window re-reads a few recent unchanged tasks; upsert absorbs them.
    expect(r.tasksFetched).toBeGreaterThanOrEqual(3);
    expect(r.tasksFetched).toBeLessThan(12);
    expect(r.tasksUpserted).toBe(3);
    const tasks = await s.tasks();
    expect(tasks.find((t) => t.externalId === "mock-task-002")?.title).toContain("revised");
    expect(tasks.find((t) => t.externalId === "mock-task-new")).toBeDefined();
    expect(tasks.find((t) => t.externalId === "mock-task-003")?.deleted).toBe(true);
  });

  it("does not commit or advance the cursor when pagination fails midway (A06)", async () => {
    const s = await setup();
    await s.sync();
    await s.select(MOCK_LIST_COURSEWORK);
    await s.sync();
    const before = await s.tasks();
    const cursorBefore = await db.syncCursor.findFirstOrThrow({
      where: { integrationId: s.integration.id },
    });
    const integrationBefore = await db.integration.findUniqueOrThrow({
      where: { id: s.integration.id },
    });

    // Force a full scan and change data, then fail on the second page.
    await db.syncCursor.updateMany({
      data: { lastFullReconciliationAt: new Date("2026-01-01T00:00:00Z") },
    });
    s.clock.advance(60_000);
    s.client.upsertTask(MOCK_LIST_COURSEWORK, { id: "mock-task-001", title: "changed" });
    s.client.purgeTask(MOCK_LIST_COURSEWORK, "mock-task-012");
    s.client.injectFailure({
      op: "listTasks",
      pageIndex: 1,
      error: new ProviderError("retryable", "http_503"),
    });

    const runsBefore = await db.syncRun.count();
    await expect(s.sync()).rejects.toMatchObject({ code: "http_503" });
    expect(await db.syncRun.count()).toBe(runsBefore + 1);

    const after = await s.tasks();
    expect(after.map((t) => [t.externalId, t.title, t.deleted])).toEqual(
      before.map((t) => [t.externalId, t.title, t.deleted]),
    );
    const cursorAfter = await db.syncCursor.findFirstOrThrow({
      where: { integrationId: s.integration.id },
    });
    expect(cursorAfter.watermark?.toISOString()).toBe(cursorBefore.watermark?.toISOString());
    const integrationAfter = await db.integration.findUniqueOrThrow({
      where: { id: s.integration.id },
    });
    expect(integrationAfter.lastSuccessAt?.toISOString()).toBe(
      integrationBefore.lastSuccessAt?.toISOString(),
    );
    expect(integrationAfter.lastErrorCode).toBe("http_503");
    const run = await db.syncRun.findFirstOrThrow({ where: { status: "failed" } });
    expect(run.status).toBe("failed");
    expect(run.safeErrorCode).toBe("http_503");
  });

  it("infers disappearance only from a complete full scan", async () => {
    const s = await setup();
    await s.sync();
    await s.select(MOCK_LIST_COURSEWORK);
    await s.sync();
    s.client.purgeTask(MOCK_LIST_COURSEWORK, "mock-task-012");
    s.clock.advance(60_000);
    await s.sync(); // incremental: cannot see the purge
    expect((await s.tasks()).find((t) => t.externalId === "mock-task-012")?.deleted).toBe(false);

    s.clock.advance(7 * 60 * 60 * 1000); // past the full-reconcile interval
    const r = await s.sync();
    expect(r.modes[MOCK_LIST_COURSEWORK]).toBe("full");
    expect(r.tasksDeleted).toBe(1);
    expect((await s.tasks()).find((t) => t.externalId === "mock-task-012")?.deleted).toBe(true);
  });

  it("marks a list unavailable (not deleted) when a complete scan no longer returns it", async () => {
    const s = await setup();
    await s.sync();
    await s.select(MOCK_LIST_PERSONAL);
    await s.sync();
    s.client.removeList(MOCK_LIST_PERSONAL);
    await s.sync();
    const list = await db.taskList.findFirstOrThrow({ where: { externalId: MOCK_LIST_PERSONAL } });
    expect(list.available).toBe(false);
    expect(await db.task.count({ where: { taskListId: list.id } })).toBe(3);
  });

  it("stores instruction-like task notes as inert text (A14)", async () => {
    const s = await setup();
    await s.sync();
    await s.select(MOCK_LIST_COURSEWORK);
    await s.sync();
    const t = (await s.tasks()).find((x) => x.externalId === "mock-task-011")!;
    expect(t.notes).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
    // Nothing in the system changed because of it: no new integrations, jobs or writes.
    expect(await db.integration.count()).toBe(1);
    expect(await db.job.count()).toBe(0);
    expect(s.client.calls.every((c) => c.op === "listTaskLists" || c.op === "listTasks")).toBe(
      true,
    );
  });
});
