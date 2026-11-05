/**
 * Canvas read-only synchronization (SCHOLAR_AI_PLAN.md §3 Canvas, §4.2, milestone M2).
 *
 *  - Courses: complete paginated scan; courses missing from a COMPLETE scan become unavailable.
 *  - Assignments per course: all pages staged, then one transaction upserts assignments and the
 *    student's own submission snapshot. Assignments missing from a complete scan become
 *    `available = false` — never deleted (it may be access loss); links to them survive.
 *  - Descriptions are converted to restricted plain text before storage; `html_url` is kept
 *    only when it is on the approved Canvas origin.
 *  - If `include[]=submission` was not honoured (scoped keys may ignore it), status is recorded
 *    as "unavailable" rather than guessed.
 *  - Every provider call is preceded by a checkpoint (integration active, job not cancelled).
 */
import { recordAudit, type Db } from "@scholar/db";
import { hashCanonical, type Clock } from "@scholar/domain";
import {
  canvasAssignmentPageSchema,
  canvasCoursePageSchema,
  ProviderError,
  type CanvasAssignment,
  type CanvasCourse,
  type CanvasReadClient,
} from "@scholar/integrations";
import { htmlToSafeText, type Logger } from "@scholar/security";
import { SyncCancelledError } from "./google-tasks-sync.ts";

const MAX_PAGES = 200;

export interface CanvasSyncDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  clientFor(integration: {
    id: string;
    userId: string;
    mode: "mock" | "live";
    config: unknown;
    baseUrl: string;
  }): Promise<CanvasReadClient>;
  isCancelled?: () => Promise<boolean>;
}

export interface CanvasSyncSummary {
  syncRunId: string;
  status: "succeeded" | "cancelled";
  courses: number;
  assignmentsFetched: number;
  assignmentsUpserted: number;
  assignmentsUnavailable: number;
  pagesFetched: number;
}

const iso = (v: string | null | undefined): Date | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

function sameOriginHttps(url: string | null | undefined, origin: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.origin === origin && u.protocol === "https:" && !u.username && !u.password
      ? u.toString()
      : null;
  } catch {
    return null;
  }
}

export function normalizeCanvasAssignment(a: CanvasAssignment, origin: string) {
  const description = a.description ? htmlToSafeText(a.description, { baseOrigin: origin }) : null;
  const rubric = (a.rubric ?? []).slice(0, 50).map((r) => ({
    description: (r.description ?? "").slice(0, 300),
    points: typeof r.points === "number" ? r.points : null,
  }));
  const base = {
    externalId: a.id,
    title: a.name.slice(0, 1024),
    descriptionText: description?.text || null,
    descriptionLinks: description?.links ?? [],
    htmlUrl: sameOriginHttps(a.html_url, origin),
    dueAt: iso(a.due_at),
    unlockAt: iso(a.unlock_at),
    lockAt: iso(a.lock_at),
    submissionTypes: a.submission_types.slice(0, 20),
    pointsPossible: typeof a.points_possible === "number" ? a.points_possible : null,
    rubric: rubric.length > 0 ? rubric : null,
    isQuiz: Boolean(
      a.is_quiz_assignment || a.quiz_id || a.submission_types.includes("online_quiz"),
    ),
    lockedForUser: Boolean(a.locked_for_user),
  };
  const submission =
    a.submission === undefined || a.submission === null
      ? {
          status: "unavailable",
          submittedAt: null,
          gradedAt: null,
          late: null,
          missing: null,
          excused: null,
          attempt: null,
        }
      : {
          status: (a.submission.workflow_state ?? "unknown").slice(0, 64),
          submittedAt: iso(a.submission.submitted_at),
          gradedAt: iso(a.submission.graded_at),
          late: a.submission.late ?? null,
          missing: a.submission.missing ?? null,
          excused: a.submission.excused ?? null,
          attempt: a.submission.attempt ?? null,
        };
  return { ...base, submission, versionHash: hashCanonical({ ...base, submission }) };
}

export async function runCanvasSync(
  deps: CanvasSyncDeps,
  input: {
    userId: string;
    integrationId: string;
    trigger: "manual" | "scheduled" | "initial";
    jobId?: string;
  },
): Promise<CanvasSyncSummary> {
  const { db, clock } = deps;
  const integration = await db.integration.findFirst({
    where: { id: input.integrationId, userId: input.userId, provider: "canvas" },
    select: { id: true, userId: true, mode: true, status: true, config: true, baseUrl: true },
  });
  if (!integration || !integration.baseUrl)
    throw new ProviderError("not_found", "integration_not_found");
  if (integration.status !== "active") throw new SyncCancelledError("integration_inactive");
  const origin = integration.baseUrl;

  const startedAt = clock.now();
  await db.integration.update({
    where: { id: integration.id },
    data: { lastAttemptAt: startedAt },
  });
  const run = await db.syncRun.create({
    data: {
      userId: input.userId,
      integrationId: integration.id,
      jobId: input.jobId,
      trigger: input.trigger,
      startedAt,
    },
    select: { id: true },
  });
  const c = {
    courses: 0,
    assignmentsFetched: 0,
    assignmentsUpserted: 0,
    assignmentsUnavailable: 0,
    pagesFetched: 0,
  };

  const checkpoint = async () => {
    const cur = await db.integration.findUnique({
      where: { id: integration.id },
      select: { status: true },
    });
    if (cur?.status !== "active") throw new SyncCancelledError("integration_inactive");
    if (deps.isCancelled && (await deps.isCancelled()))
      throw new SyncCancelledError("job_cancelled");
  };

  try {
    const client = await deps.clientFor({ ...integration, baseUrl: origin });

    // ---- courses (complete scan) ----
    const courses: CanvasCourse[] = [];
    let next: string | undefined;
    let pages = 0;
    do {
      await checkpoint();
      const page = await client.listCourses(next);
      c.pagesFetched++;
      courses.push(...canvasCoursePageSchema.parse(page.items));
      next = page.next;
      if (++pages > MAX_PAGES) throw new ProviderError("fatal", "too_many_pages");
    } while (next);
    c.courses = courses.length;
    const now = clock.now();
    const courseIds = new Map<string, string>();
    await db.$transaction(async (tx) => {
      for (const course of courses) {
        const row = await tx.course.upsert({
          where: {
            integrationId_externalId: { integrationId: integration.id, externalId: course.id },
          },
          create: {
            userId: input.userId,
            integrationId: integration.id,
            externalId: course.id,
            name: course.name.slice(0, 1024),
            courseCode: course.course_code?.slice(0, 256) ?? null,
            workflowState: course.workflow_state ?? null,
            lastSeenAt: now,
          },
          update: {
            name: course.name.slice(0, 1024),
            courseCode: course.course_code?.slice(0, 256) ?? null,
            workflowState: course.workflow_state ?? null,
            available: true,
            lastSeenAt: now,
          },
          select: { id: true },
        });
        courseIds.set(course.id, row.id);
      }
      await tx.course.updateMany({
        where: {
          userId: input.userId,
          integrationId: integration.id,
          externalId: { notIn: courses.map((x) => x.id) },
        },
        data: { available: false },
      });
      await tx.assignment.updateMany({
        where: {
          userId: input.userId,
          integrationId: integration.id,
          course: { available: false },
        },
        data: { available: false },
      });
    });

    // ---- assignments per course (staged, then one commit per course) ----
    for (const course of courses) {
      const courseId = courseIds.get(course.id)!;
      const staged: CanvasAssignment[] = [];
      let token: string | undefined;
      let coursePages = 0;
      let lostAccess = false;
      do {
        await checkpoint();
        let page;
        try {
          page = await client.listAssignments(course.id, token);
        } catch (e) {
          if (e instanceof ProviderError && e.kind === "not_found") {
            lostAccess = true; // course vanished or access was removed mid-sync
            break;
          }
          throw e;
        }
        c.pagesFetched++;
        staged.push(...canvasAssignmentPageSchema.parse(page.items));
        token = page.next;
        if (++coursePages > MAX_PAGES) throw new ProviderError("fatal", "too_many_pages");
      } while (token);

      if (lostAccess) {
        await db.$transaction([
          db.course.update({ where: { id: courseId }, data: { available: false } }),
          db.assignment.updateMany({
            where: { userId: input.userId, courseId },
            data: { available: false },
          }),
        ]);
        continue;
      }
      c.assignmentsFetched += staged.length;
      const normalized = staged.map((a) => normalizeCanvasAssignment(a, origin));
      const syncedAt = clock.now();
      const result = await db.$transaction(
        async (tx) => {
          const existing = await tx.assignment.findMany({
            where: {
              integrationId: integration.id,
              externalId: { in: normalized.map((n) => n.externalId) },
            },
            select: {
              id: true,
              externalId: true,
              versionHash: true,
              available: true,
              courseId: true,
            },
          });
          const byExt = new Map(existing.map((e) => [e.externalId, e]));
          let upserted = 0;
          for (const n of normalized) {
            const { submission, ...fields } = n;
            const data = {
              ...fields,
              courseId,
              available: true,
              syncedAt,
              rubric: fields.rubric ?? undefined,
            };
            const prev = byExt.get(n.externalId);
            let assignmentId: string;
            if (!prev) {
              const created = await tx.assignment.create({
                data: { ...data, userId: input.userId, integrationId: integration.id },
                select: { id: true },
              });
              assignmentId = created.id;
              upserted++;
            } else if (
              prev.versionHash !== n.versionHash ||
              !prev.available ||
              prev.courseId !== courseId
            ) {
              await tx.assignment.update({ where: { id: prev.id }, data });
              assignmentId = prev.id;
              upserted++;
            } else {
              await tx.assignment.update({ where: { id: prev.id }, data: { syncedAt } });
              assignmentId = prev.id;
            }
            await tx.submissionSnapshot.upsert({
              where: { assignmentId },
              create: { userId: input.userId, assignmentId, ...submission, syncedAt },
              update: { ...submission, syncedAt },
            });
          }
          // Complete scan: anything not returned is unavailable, never deleted.
          const gone = await tx.assignment.updateMany({
            where: {
              userId: input.userId,
              courseId,
              available: true,
              externalId: { notIn: normalized.map((n) => n.externalId) },
            },
            data: { available: false },
          });
          return { upserted, unavailable: gone.count };
        },
        { timeout: 60_000 },
      );
      c.assignmentsUpserted += result.upserted;
      c.assignmentsUnavailable += result.unavailable;
    }

    const finishedAt = clock.now();
    await db.$transaction([
      db.syncRun.update({
        where: { id: run.id },
        data: {
          status: "succeeded",
          finishedAt,
          pagesFetched: c.pagesFetched,
          listsSeen: c.courses,
          tasksFetched: c.assignmentsFetched,
          tasksUpserted: c.assignmentsUpserted,
          tasksDeleted: c.assignmentsUnavailable,
        },
      }),
      db.integration.update({
        where: { id: integration.id },
        data: { lastSuccessAt: finishedAt, lastErrorCode: null, lastErrorAt: null },
      }),
    ]);
    deps.logger.info("canvas.sync.succeeded", {
      integrationId: integration.id,
      syncRunId: run.id,
      ...c,
    });
    return { syncRunId: run.id, status: "succeeded", ...c };
  } catch (error) {
    const finishedAt = clock.now();
    if (error instanceof SyncCancelledError) {
      await db.syncRun.update({
        where: { id: run.id },
        data: { status: "cancelled", finishedAt, safeErrorCode: error.reason },
      });
      return { syncRunId: run.id, status: "cancelled", ...c };
    }
    const code =
      error instanceof ProviderError
        ? error.code
        : (error as { name?: string })?.name === "ZodError"
          ? "invalid_provider_response"
          : "internal_error";
    await db.syncRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt, safeErrorCode: code },
    });
    const authFailure = error instanceof ProviderError && error.kind === "auth";
    await db.integration.update({
      where: { id: integration.id },
      data: {
        lastErrorCode: code,
        lastErrorAt: finishedAt,
        ...(authFailure ? { status: "needs_reconnect" } : {}),
      },
    });
    if (authFailure) {
      await recordAudit(db, {
        userId: input.userId,
        actor: "worker",
        action: "integration.needs_reconnect",
        targetType: "integration",
        targetId: integration.id,
        metadata: { code },
      });
    }
    deps.logger.warn("canvas.sync.failed", {
      integrationId: integration.id,
      code,
      errorName: (error as { name?: string })?.name,
    });
    throw error instanceof ProviderError ? error : new ProviderError("fatal", code);
  }
}
