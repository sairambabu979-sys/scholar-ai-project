import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  enqueueJob,
  getOwnedIntegration,
  getOwnedJob,
  getOwnedTask,
  listDashboardTasks,
  listIntegrations,
  listTasksPage,
  setSelectedLists,
} from "@scholar/db";
import {
  buildMockGoogleTasksDataset,
  FixedClock,
  MOCK_LIST_COURSEWORK,
  MockGoogleTasksClient,
} from "@scholar/testing";
import { runGoogleTasksSync } from "../../apps/worker/src/handlers/google-tasks-sync.ts";
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

/** Two users with identical synthetic data; neither may see or touch the other's rows (A01). */
let alice: { id: string };
let bob: { id: string };
let aliceIntegration: { id: string };
let aliceTaskId: string;
let aliceListId: string;
let aliceJobId: string;

beforeAll(async () => {
  await resetDatabase(db);
  const clock = new FixedClock("2026-11-04T15:00:00.000Z");
  alice = await createUser(db, "alice@scholar.example", "America/New_York");
  bob = await createUser(db, "bob@scholar.example", "Asia/Tokyo");
  for (const u of [alice, bob]) {
    const integration = await createMockIntegration(db, u.id);
    if (u === alice) aliceIntegration = integration;
    const client = new MockGoogleTasksClient(buildMockGoogleTasksDataset("2026-11-04"), { clock });
    const deps = { db, clock, logger: silentLogger, clientFor: async () => client };
    const input = { userId: u.id, integrationId: integration.id, trigger: "manual" as const };
    await runGoogleTasksSync(deps, input);
    await db.taskList.updateMany({
      where: { integrationId: integration.id, externalId: MOCK_LIST_COURSEWORK },
      data: { selected: true },
    });
    await runGoogleTasksSync(deps, input);
  }
  const t = await db.task.findFirstOrThrow({ where: { userId: alice.id, deleted: false } });
  aliceTaskId = t.id;
  aliceListId = t.taskListId;
  aliceJobId = (await enqueueJob(db, { userId: alice.id, kind: "k", payload: {} })).id;
});

describe("two-user isolation (A01)", () => {
  it("each user sees only their own tasks and integrations", async () => {
    const [a, b] = await Promise.all([
      listDashboardTasks(db, alice.id),
      listDashboardTasks(db, bob.id),
    ]);
    expect(a.length).toBe(b.length);
    const aIds = new Set(a.map((t) => t.id));
    expect(b.some((t) => aIds.has(t.id))).toBe(false);
    expect((await listIntegrations(db, bob.id)).map((i) => i.id)).not.toContain(
      aliceIntegration.id,
    );
    const page = await listTasksPage(db, bob.id, { limit: 100 });
    expect(page.items.some((t) => aIds.has(t.id))).toBe(false);
  });

  it("another user's IDs behave exactly like missing IDs", async () => {
    expect(await getOwnedTask(db, bob.id, aliceTaskId)).toBeNull();
    expect(await getOwnedIntegration(db, bob.id, aliceIntegration.id)).toBeNull();
    expect(await getOwnedJob(db, bob.id, aliceJobId)).toBeNull();
    expect(await listTasksPage(db, bob.id, { limit: 10, listId: aliceListId })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it("cannot mutate another user's integration or list selection", async () => {
    expect(await disconnect(db, bob.id, aliceIntegration.id, true, new Date())).toBeNull();
    expect(await setSelectedLists(db, bob.id, aliceIntegration.id, [aliceListId])).toEqual({
      ok: false,
      reason: "not_found",
    });
    const bobIntegration = (await listIntegrations(db, bob.id))[0]!;
    expect(await setSelectedLists(db, bob.id, bobIntegration.id, [aliceListId])).toEqual({
      ok: false,
      reason: "invalid_list",
    });
    const stillThere = await db.integration.findUniqueOrThrow({
      where: { id: aliceIntegration.id },
    });
    expect(stillThere.status).toBe("active");
    expect(await db.task.count({ where: { userId: alice.id } })).toBeGreaterThan(0);
  });

  it("the database refuses rows that point at another user's parent (composite FKs)", async () => {
    await expect(
      db.task.create({
        data: {
          userId: bob.id,
          integrationId: aliceIntegration.id,
          taskListId: aliceListId,
          externalId: "evil",
          title: "x",
          status: "needs_action",
          versionHash: "x",
          syncedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});
