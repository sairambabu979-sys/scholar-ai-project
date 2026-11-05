/**
 * Owner-scoped access to Canvas context, task links and manual context (milestone M2).
 * Every function filters by the session user's id; composite foreign keys additionally make
 * cross-user links impossible at the database level.
 */
import { createHash } from "node:crypto";
import { dateOnlyToDbDate, dbDateToDateOnly, type DateOnly } from "@scholar/domain";
import type { Db } from "./client.ts";
import type { Prisma } from "./generated/prisma/client.ts";
import { recordAudit } from "./audit.ts";

export const CANVAS_SYNC_JOB = "canvas.sync";
export const MOCK_CANVAS_EXTERNAL_ACCOUNT = "mock-canvas";

/** Connect the MOCK Canvas adapter (synthetic fixtures, labelled everywhere). */
export async function connectMockCanvas(
  db: Db,
  userId: string,
  anchorDate: DateOnly,
  mockOrigin: string,
  requestId?: string,
) {
  return db.$transaction(async (tx) => {
    const integration = await tx.integration.upsert({
      where: {
        userId_provider_externalAccountId: {
          userId,
          provider: "canvas",
          externalAccountId: MOCK_CANVAS_EXTERNAL_ACCOUNT,
        },
      },
      create: {
        userId,
        provider: "canvas",
        mode: "mock",
        status: "active",
        externalAccountId: MOCK_CANVAS_EXTERNAL_ACCOUNT,
        baseUrl: mockOrigin,
        scopes: ["mock:canvas.readonly"],
        config: { mockAnchorDate: anchorDate },
      },
      update: {
        status: "active",
        disconnectedAt: null,
        connectedAt: new Date(),
        lastErrorCode: null,
      },
      select: { id: true, status: true, mode: true },
    });
    await recordAudit(tx, {
      userId,
      actor: "user",
      action: "integration.connected",
      targetType: "integration",
      targetId: integration.id,
      metadata: { provider: "canvas", mode: "mock" },
      requestId,
    });
    return integration;
  });
}

/** Origins of the student's connected Canvas instances (for exact URL matching). */
export async function approvedCanvasOrigins(db: Db, userId: string): Promise<string[]> {
  const rows = await db.integration.findMany({
    where: { userId, provider: "canvas", status: { not: "disconnected" }, baseUrl: { not: null } },
    select: { baseUrl: true },
  });
  return [...new Set(rows.map((r) => r.baseUrl!))];
}

export async function listAssignmentsForMatching(db: Db, userId: string) {
  return db.assignment.findMany({
    where: { userId, integration: { status: { not: "disconnected" } } },
    select: {
      id: true,
      externalId: true,
      title: true,
      dueAt: true,
      available: true,
      course: { select: { externalId: true, name: true, courseCode: true } },
    },
    take: 2000,
  });
}

const assignmentDetailSelect = {
  id: true,
  title: true,
  descriptionText: true,
  descriptionLinks: true,
  htmlUrl: true,
  dueAt: true,
  unlockAt: true,
  lockAt: true,
  submissionTypes: true,
  pointsPossible: true,
  rubric: true,
  isQuiz: true,
  lockedForUser: true,
  available: true,
  syncedAt: true,
  course: { select: { id: true, name: true, courseCode: true } },
  integration: { select: { id: true, mode: true, status: true, baseUrl: true } },
  submission: {
    select: {
      status: true,
      submittedAt: true,
      gradedAt: true,
      late: true,
      missing: true,
      excused: true,
      attempt: true,
      syncedAt: true,
    },
  },
} as const;
export type AssignmentDetail = Prisma.AssignmentGetPayload<{
  select: typeof assignmentDetailSelect;
}>;

export async function getOwnedAssignment(db: Db, userId: string, assignmentId: string) {
  return db.assignment.findFirst({
    where: { id: assignmentId, userId },
    select: assignmentDetailSelect,
  });
}

/** Everything the task detail page needs, owner-scoped. */
export async function getTaskContext(db: Db, userId: string, taskId: string) {
  const task = await db.task.findFirst({
    where: { id: taskId, userId },
    select: {
      id: true,
      title: true,
      notes: true,
      status: true,
      dueDate: true,
      deleted: true,
      versionHash: true,
      webViewLink: true,
      taskList: { select: { title: true } },
      integration: { select: { mode: true } },
      link: {
        select: {
          method: true,
          confidence: true,
          reasons: true,
          confirmedAt: true,
          assignment: { select: assignmentDetailSelect },
        },
      },
      manualContext: {
        select: {
          title: true,
          requirements: true,
          sources: true,
          dueDate: true,
          dueAt: true,
          version: true,
          versionHash: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!task) return null;
  return {
    ...task,
    dueDate: task.dueDate ? dbDateToDateOnly(task.dueDate) : null,
    manualContext: task.manualContext
      ? {
          ...task.manualContext,
          dueDate: task.manualContext.dueDate ? dbDateToDateOnly(task.manualContext.dueDate) : null,
        }
      : null,
  };
}

export type ConfirmLinkResult =
  | { ok: true; linkId: string }
  | { ok: false; reason: "not_found" | "stale" | "assignment_unavailable" };

/**
 * Confirm a specific owned assignment for an owned task. `expectedTaskVersion` must match the
 * task's current version (the student reviewed what they are linking).
 */
export async function confirmTaskLink(
  db: Db,
  userId: string,
  input: {
    taskId: string;
    assignmentId: string;
    method: "url" | "suggested" | "manual";
    confidence: number | null;
    reasons: string[];
    expectedTaskVersion: string;
    requestId?: string;
  },
): Promise<ConfirmLinkResult> {
  return db.$transaction(async (tx) => {
    const task = await tx.task.findFirst({
      where: { id: input.taskId, userId },
      select: { id: true, versionHash: true },
    });
    const assignment = await tx.assignment.findFirst({
      where: { id: input.assignmentId, userId, integration: { status: { not: "disconnected" } } },
      select: { id: true, available: true },
    });
    if (!task || !assignment) return { ok: false, reason: "not_found" } as const;
    if (task.versionHash !== input.expectedTaskVersion)
      return { ok: false, reason: "stale" } as const;
    if (!assignment.available) return { ok: false, reason: "assignment_unavailable" } as const;
    const data = {
      assignmentId: assignment.id,
      method: input.method,
      confidence: input.confidence,
      reasons: input.reasons.slice(0, 5).map((r) => r.slice(0, 200)),
      confirmedAt: new Date(),
    };
    const link = await tx.taskLink.upsert({
      where: { taskId: task.id },
      create: { userId, taskId: task.id, ...data },
      update: data,
      select: { id: true },
    });
    await recordAudit(tx, {
      userId,
      actor: "user",
      action: "task.link_confirmed",
      targetType: "task",
      targetId: task.id,
      metadata: { assignmentId: assignment.id, method: input.method },
      requestId: input.requestId,
    });
    return { ok: true, linkId: link.id } as const;
  });
}

export async function removeTaskLink(
  db: Db,
  userId: string,
  taskId: string,
  requestId?: string,
): Promise<boolean> {
  const r = await db.taskLink.deleteMany({ where: { taskId, userId } });
  if (r.count > 0) {
    await recordAudit(db, {
      userId,
      actor: "user",
      action: "task.link_removed",
      targetType: "task",
      targetId: taskId,
      requestId,
    });
  }
  return r.count > 0;
}

export interface ManualContextInput {
  title: string;
  requirements: string;
  sources: string[];
  dueDate: DateOnly | null;
  dueAt: Date | null;
}

const manualHash = (m: ManualContextInput) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        m.title,
        m.requirements,
        m.sources,
        m.dueDate,
        m.dueAt?.toISOString() ?? null,
      ]),
    )
    .digest("hex");

/** Save student-supplied context, versioned. `expectedVersion` guards concurrent edits. */
export async function upsertManualContext(
  db: Db,
  userId: string,
  taskId: string,
  input: ManualContextInput,
  expectedVersion: number | null,
  requestId?: string,
): Promise<{ ok: true; version: number } | { ok: false; reason: "not_found" | "stale" }> {
  return db.$transaction(async (tx) => {
    const task = await tx.task.findFirst({ where: { id: taskId, userId }, select: { id: true } });
    if (!task) return { ok: false, reason: "not_found" } as const;
    const existing = await tx.manualContext.findUnique({
      where: { taskId },
      select: { version: true },
    });
    if ((existing?.version ?? null) !== expectedVersion)
      return { ok: false, reason: "stale" } as const;
    const data = {
      title: input.title,
      requirements: input.requirements,
      sources: input.sources,
      dueDate: input.dueDate ? dateOnlyToDbDate(input.dueDate) : null,
      dueAt: input.dueAt,
      versionHash: manualHash(input),
    };
    const saved = await tx.manualContext.upsert({
      where: { taskId },
      create: { userId, taskId, ...data },
      update: { ...data, version: { increment: 1 } },
      select: { version: true },
    });
    await recordAudit(tx, {
      userId,
      actor: "user",
      action: "task.manual_context_saved",
      targetType: "task",
      targetId: taskId,
      metadata: {
        version: saved.version,
        sources: input.sources.length,
        hasDue: Boolean(input.dueDate || input.dueAt),
      },
      requestId,
    });
    return { ok: true, version: saved.version } as const;
  });
}

export async function deleteManualContext(
  db: Db,
  userId: string,
  taskId: string,
  requestId?: string,
): Promise<boolean> {
  const r = await db.manualContext.deleteMany({ where: { taskId, userId } });
  if (r.count > 0) {
    await recordAudit(db, {
      userId,
      actor: "user",
      action: "task.manual_context_deleted",
      targetType: "task",
      targetId: taskId,
      requestId,
    });
  }
  return r.count > 0;
}

export async function listOwnedCourses(db: Db, userId: string) {
  return db.course.findMany({
    where: { userId, integration: { status: { not: "disconnected" } } },
    select: {
      id: true,
      name: true,
      courseCode: true,
      available: true,
      integration: { select: { id: true, mode: true } },
    },
    orderBy: { name: "asc" },
  });
}

export async function listOwnedAssignmentsPage(
  db: Db,
  userId: string,
  q: { limit: number; cursor?: string; courseId?: string },
) {
  const rows = await db.assignment.findMany({
    where: {
      userId,
      integration: { status: { not: "disconnected" } },
      ...(q.courseId ? { courseId: q.courseId } : {}),
      ...(q.cursor ? { id: { gt: q.cursor } } : {}),
    },
    select: {
      id: true,
      title: true,
      dueAt: true,
      htmlUrl: true,
      available: true,
      isQuiz: true,
      course: { select: { id: true, name: true, courseCode: true } },
      submission: { select: { status: true, late: true, missing: true } },
    },
    orderBy: { id: "asc" },
    take: q.limit + 1,
  });
  const hasMore = rows.length > q.limit;
  const items = rows.slice(0, q.limit);
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}
