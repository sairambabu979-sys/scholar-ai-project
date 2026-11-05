import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  approvedCanvasOrigins,
  confirmTaskLink,
  getTaskContext,
  listAssignmentsForMatching,
  listDashboardTasks,
  removeTaskLink,
  upsertManualContext,
} from "@scholar/db";
import {
  effectiveDeadline,
  extractCanvasAssignmentRefs,
  rankCandidates,
  todayInTimeZone,
} from "@scholar/domain";
import {
  buildMockGoogleTasksDataset,
  FixedClock,
  MOCK_LIST_COURSEWORK,
  MockGoogleTasksClient,
} from "@scholar/testing";
import { runGoogleTasksSync } from "../../apps/worker/src/handlers/google-tasks-sync.ts";
import { runCanvasSync } from "../../apps/worker/src/handlers/canvas-sync.ts";
import {
  createMockIntegration,
  createUser,
  resetDatabase,
  silentLogger,
  testDb,
} from "../support/db-helpers.ts";
import { mockCanvas } from "../support/canvas-fixtures.ts";

const db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDatabase(db));

async function student(email: string, opts: { canvas?: boolean } = { canvas: true }) {
  const user = await createUser(db, email, "America/New_York");
  const clock = new FixedClock("2026-11-04T15:00:00.000Z");
  const tasks = await createMockIntegration(db, user.id);
  const client = new MockGoogleTasksClient(buildMockGoogleTasksDataset("2026-11-04"), { clock });
  const deps = { db, clock, logger: silentLogger, clientFor: async () => client };
  const input = { userId: user.id, integrationId: tasks.id, trigger: "manual" as const };
  await runGoogleTasksSync(deps, input);
  await db.taskList.updateMany({
    where: { integrationId: tasks.id, externalId: MOCK_LIST_COURSEWORK },
    data: { selected: true },
  });
  await runGoogleTasksSync(deps, input);
  if (opts.canvas) {
    const h = await mockCanvas(db, user.id);
    await runCanvasSync(h.deps, h.input);
  }
  const task = (ext: string) =>
    db.task.findFirstOrThrow({ where: { userId: user.id, externalId: ext } });
  const candidatesFor = async (ext: string) => {
    const t = await task(ext);
    const [origins, assignments] = await Promise.all([
      approvedCanvasOrigins(db, user.id),
      listAssignmentsForMatching(db, user.id),
    ]);
    return rankCandidates(
      {
        title: t.title,
        notes: t.notes,
        dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
      },
      assignments.map((a) => ({
        id: a.id,
        externalId: a.externalId,
        title: a.title,
        courseName: a.course.name,
        courseCode: a.course.courseCode,
        courseExternalId: a.course.externalId,
        dueDate: a.dueAt ? todayInTimeZone(a.dueAt, "America/New_York") : null,
        available: a.available,
      })),
      extractCanvasAssignmentRefs(`${t.title}\n${t.notes ?? ""}`, origins),
    );
  };
  return { user, task, candidatesFor };
}

describe("task ↔ assignment linking", () => {
  it("finds an exact URL match, ranks ambiguous ones, and links nothing by itself (A10)", async () => {
    const s = await student("k1@scholar.example");
    const lab = await s.candidatesFor("mock-task-001");
    expect(lab[0]).toMatchObject({ method: "url", confidence: 1 });
    const ps7 = await s.candidatesFor("mock-task-002");
    expect(ps7.length).toBeGreaterThanOrEqual(2);
    expect(ps7.every((c) => c.method === "suggested")).toBe(true);
    expect(await db.taskLink.count()).toBe(0);
  });

  it("links only on explicit confirmation of the reviewed task version", async () => {
    const s = await student("k2@scholar.example");
    const t = await s.task("mock-task-002");
    const [best] = await s.candidatesFor("mock-task-002");
    expect(
      await confirmTaskLink(db, s.user.id, {
        taskId: t.id,
        assignmentId: best!.assignmentId,
        method: "suggested",
        confidence: best!.confidence,
        reasons: best!.reasons,
        expectedTaskVersion: "stale",
      }),
    ).toEqual({ ok: false, reason: "stale" });
    const ok = await confirmTaskLink(db, s.user.id, {
      taskId: t.id,
      assignmentId: best!.assignmentId,
      method: "suggested",
      confidence: best!.confidence,
      reasons: best!.reasons,
      expectedTaskVersion: t.versionHash,
    });
    expect(ok.ok).toBe(true);
    const ctx = await getTaskContext(db, s.user.id, t.id);
    expect(ctx?.link?.assignment.title).toBe("Problem Set 7");
    expect(await removeTaskLink(db, s.user.id, t.id)).toBe(true);
    expect(await db.taskLink.count()).toBe(0);
  });

  it("shows the Canvas override deadline with provenance and the Google disagreement (A09)", async () => {
    const s = await student("k3@scholar.example");
    const essay = await s.task("mock-task-004");
    const [exact] = await s.candidatesFor("mock-task-004");
    await confirmTaskLink(db, s.user.id, {
      taskId: essay.id,
      assignmentId: exact!.assignmentId,
      method: "url",
      confidence: 1,
      reasons: exact!.reasons,
      expectedTaskVersion: essay.versionHash,
    });
    const view = (await listDashboardTasks(db, s.user.id)).find((x) => x.id === essay.id)!;
    const d = effectiveDeadline(
      { canvasDueAt: view.link!.assignment.dueAt, googleDueDate: view.dueDate },
      "America/New_York",
    )!;
    expect(d).toMatchObject({ source: "canvas", date: "2026-11-10" });
    expect(d.conflicts).toEqual([{ source: "google", date: "2026-11-09" }]);
  });

  it("refuses unavailable assignments and keeps existing links visible when one vanishes", async () => {
    const s = await student("k4@scholar.example");
    const t = await s.task("mock-task-002");
    const [best] = await s.candidatesFor("mock-task-002");
    await confirmTaskLink(db, s.user.id, {
      taskId: t.id,
      assignmentId: best!.assignmentId,
      method: "suggested",
      confidence: best!.confidence,
      reasons: [],
      expectedTaskVersion: t.versionHash,
    });
    await db.assignment.update({ where: { id: best!.assignmentId }, data: { available: false } });
    const view = (await listDashboardTasks(db, s.user.id)).find((x) => x.id === t.id)!;
    expect(view.link?.assignment.available).toBe(false);
    const other = await s.task("mock-task-005");
    expect(
      await confirmTaskLink(db, s.user.id, {
        taskId: other.id,
        assignmentId: best!.assignmentId,
        method: "manual",
        confidence: null,
        reasons: [],
        expectedTaskVersion: other.versionHash,
      }),
    ).toEqual({ ok: false, reason: "assignment_unavailable" });
  });

  it("works without Canvas: manual context is versioned and overrides the deadline (A08)", async () => {
    const s = await student("k5@scholar.example", { canvas: false });
    expect(await approvedCanvasOrigins(db, s.user.id)).toEqual([]);
    const t = await s.task("mock-task-011");
    const input = {
      title: "Office hours email",
      requirements: "Ask about the lab rubric.",
      sources: ["https://school.example/syllabus"],
      dueDate: "2026-11-07" as const,
      dueAt: null,
    };
    expect(await upsertManualContext(db, s.user.id, t.id, input, null)).toEqual({
      ok: true,
      version: 1,
    });
    expect(await upsertManualContext(db, s.user.id, t.id, input, null)).toEqual({
      ok: false,
      reason: "stale",
    });
    expect(
      await upsertManualContext(db, s.user.id, t.id, { ...input, requirements: "v2" }, 1),
    ).toEqual({ ok: true, version: 2 });
    const view = (await listDashboardTasks(db, s.user.id)).find((x) => x.id === t.id)!;
    expect(view.manualContext).toMatchObject({
      title: "Office hours email",
      dueDate: "2026-11-07",
    });
    expect(
      effectiveDeadline(
        { manualDueDate: view.manualContext!.dueDate, googleDueDate: view.dueDate },
        "UTC",
      )!.source,
    ).toBe("manual");
  });

  it("cannot link to, read, or annotate another student's records (A01)", async () => {
    const a = await student("k6a@scholar.example");
    const b = await student("k6b@scholar.example");
    const bTask = await b.task("mock-task-001");
    const aAssignment = await db.assignment.findFirstOrThrow({ where: { userId: a.user.id } });
    expect(
      await confirmTaskLink(db, b.user.id, {
        taskId: bTask.id,
        assignmentId: aAssignment.id,
        method: "manual",
        confidence: null,
        reasons: [],
        expectedTaskVersion: bTask.versionHash,
      }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await getTaskContext(db, a.user.id, bTask.id)).toBeNull();
    expect(
      await upsertManualContext(
        db,
        a.user.id,
        bTask.id,
        { title: "x", requirements: "", sources: [], dueDate: null, dueAt: null },
        null,
      ),
    ).toEqual({ ok: false, reason: "not_found" });
    // Database-level guarantee: a cross-user link row is impossible.
    await expect(
      db.taskLink.create({
        data: {
          userId: b.user.id,
          taskId: bTask.id,
          assignmentId: aAssignment.id,
          method: "manual",
          confirmedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});
