import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ProviderError } from "@scholar/integrations";
import { runCanvasSync } from "../../apps/worker/src/handlers/canvas-sync.ts";
import { createUser, resetDatabase, testDb } from "../support/db-helpers.ts";
import { mockCanvas } from "../support/canvas-fixtures.ts";

const db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDatabase(db));

describe("Canvas sync (mock adapter)", () => {
  it("imports the student's courses and assignments with student-effective dates", async () => {
    const user = await createUser(db, "c1@scholar.example", "America/New_York");
    const h = await mockCanvas(db, user.id);
    const r = await runCanvasSync(h.deps, h.input);
    expect(r).toMatchObject({ status: "succeeded", courses: 4, assignmentsFetched: 9 });
    const lab = await db.assignment.findFirstOrThrow({
      where: { externalId: "50011" },
      include: { submission: true, course: true },
    });
    expect(lab.course.courseCode).toBe("BIO 110");
    expect(lab.dueAt?.toISOString()).toBe("2026-11-05T04:59:00.000Z"); // 23:59 EST on Nov 4
    expect(lab.htmlUrl).toBe("https://canvas.school.example/courses/1101/assignments/50011");
    expect(lab.submission?.status).toBe("unsubmitted");
    expect(lab.rubric).toEqual([
      { description: "Introduction and hypothesis", points: 10 },
      { description: "Methods are reproducible", points: 15 },
      { description: "Results and analysis", points: 25 },
    ]);
  });

  it("stores descriptions as restricted text: no script, no tracking image, no javascript link (A15)", async () => {
    const user = await createUser(db, "c2@scholar.example");
    const h = await mockCanvas(db, user.id);
    await runCanvasSync(h.deps, h.input);
    const lab = await db.assignment.findFirstOrThrow({ where: { externalId: "50011" } });
    expect(lab.descriptionText).toContain("Write up the enzyme kinetics lab");
    for (const bad of ["document.location", "cookie", "evil.example", "javascript:", "<"]) {
      expect(lab.descriptionText).not.toContain(bad);
    }
    expect(lab.descriptionLinks).toEqual(["https://canvas.school.example/courses/1101/files/9001"]);
  });

  it("records submission status as unavailable when Canvas did not include it, and flags quizzes", async () => {
    const user = await createUser(db, "c3@scholar.example");
    const h = await mockCanvas(db, user.id);
    await runCanvasSync(h.deps, h.input);
    const essay = await db.assignment.findFirstOrThrow({
      where: { externalId: "50042" },
      include: { submission: true },
    });
    expect(essay.submission?.status).toBe("unavailable");
    const quiz = await db.assignment.findFirstOrThrow({ where: { externalId: "50012" } });
    expect(quiz.isQuiz).toBe(true);
    const missing = await db.assignment.findFirstOrThrow({
      where: { externalId: "22106" },
      include: { submission: true },
    });
    expect(missing.submission).toMatchObject({ missing: true, late: true });
  });

  it("is idempotent and marks vanished assignments unavailable instead of deleting them", async () => {
    const user = await createUser(db, "c4@scholar.example");
    const h = await mockCanvas(db, user.id);
    await runCanvasSync(h.deps, h.input);
    const again = await runCanvasSync(h.deps, h.input);
    expect(again.assignmentsUpserted).toBe(0);
    expect(await db.assignment.count()).toBe(9);

    h.client.removeAssignment("2210", 22107);
    const r = await runCanvasSync(h.deps, h.input);
    expect(r.assignmentsUnavailable).toBe(1);
    const ps7 = await db.assignment.findFirstOrThrow({ where: { externalId: "22107" } });
    expect(ps7.available).toBe(false);
    expect(await db.assignment.count()).toBe(9);
  });

  it("does not commit a course's assignments when pagination fails midway", async () => {
    const user = await createUser(db, "c5@scholar.example");
    const h = await mockCanvas(db, user.id);
    h.client.injectFailure({
      op: "assignments",
      course: "2210",
      page: 1,
      error: new ProviderError("retryable", "canvas_http_503"),
    });
    await expect(runCanvasSync(h.deps, h.input)).rejects.toMatchObject({ code: "canvas_http_503" });
    expect(await db.assignment.count({ where: { course: { externalId: "2210" } } })).toBe(0);
    const integration = await db.integration.findUniqueOrThrow({ where: { id: h.integration.id } });
    expect(integration.lastSuccessAt).toBeNull();
    expect(integration.lastErrorCode).toBe("canvas_http_503");
  });

  it("treats a course that disappears mid-sync as access loss, not deletion", async () => {
    const user = await createUser(db, "c6@scholar.example");
    const h = await mockCanvas(db, user.id);
    await runCanvasSync(h.deps, h.input);
    h.client.injectFailure({
      op: "assignments",
      course: "2040",
      page: 0,
      error: new ProviderError("not_found", "canvas_not_found"),
    });
    const r = await runCanvasSync(h.deps, h.input);
    expect(r.status).toBe("succeeded");
    const hist = await db.course.findFirstOrThrow({ where: { externalId: "2040" } });
    expect(hist.available).toBe(false);
    expect(await db.assignment.count({ where: { courseId: hist.id, available: false } })).toBe(2);
  });
});
