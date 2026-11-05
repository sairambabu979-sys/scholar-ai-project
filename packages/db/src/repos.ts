/**
 * Owner-scoped data access. Every function takes the authenticated `userId` from the server
 * session (never from client input) and filters by it, so another user's identifiers behave
 * exactly like absent ones (404, no existence leak).
 */
import { dbDateToDateOnly, type DateOnly } from "@scholar/domain";
import type { Db } from "./client.ts";
import type { Prisma } from "./generated/prisma/client.ts";
import { recordAudit } from "./audit.ts";

export const GOOGLE_TASKS_SYNC_JOB = "google_tasks.sync";
export const syncDedupeKey = (integrationId: string) => `sync:${integrationId}`;

// ---- users and preferences ----------------------------------------------------------------

export async function getProfile(db: Db, userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, timezone: true, createdAt: true },
  });
  if (!user) return null;
  const preference = await db.preference.upsert({
    where: { userId },
    create: { userId },
    update: {},
    select: { syncEnabled: true, onboardingCompletedAt: true, aiDataUseConsent: true },
  });
  return { ...user, timezone: user.timezone ?? "UTC", preference };
}

export async function updatePreferences(
  db: Db,
  userId: string,
  input: { timezone?: string; syncEnabled?: boolean; onboardingCompleted?: boolean },
  requestId?: string,
) {
  return db.$transaction(async (tx) => {
    if (input.timezone) {
      await tx.user.update({ where: { id: userId }, data: { timezone: input.timezone } });
    }
    const data: Prisma.PreferenceUpdateInput = {};
    if (input.syncEnabled !== undefined) data.syncEnabled = input.syncEnabled;
    if (input.onboardingCompleted) data.onboardingCompletedAt = new Date();
    await tx.preference.upsert({
      where: { userId },
      create: { userId, ...data } as Prisma.PreferenceUncheckedCreateInput,
      update: data,
    });
    await recordAudit(tx, {
      userId,
      actor: "user",
      action: "preferences.updated",
      metadata: { fields: Object.keys(input) },
      requestId,
    });
  });
}

// ---- integrations -------------------------------------------------------------------------

const integrationSafeSelect = {
  id: true,
  provider: true,
  mode: true,
  status: true,
  scopes: true,
  lastAttemptAt: true,
  lastSuccessAt: true,
  lastErrorCode: true,
  lastErrorAt: true,
  connectedAt: true,
  disconnectedAt: true,
} as const;

export type SafeIntegration = Prisma.IntegrationGetPayload<{
  select: typeof integrationSafeSelect;
}>;

/** Connection health without any credential material. */
export async function listIntegrations(db: Db, userId: string): Promise<SafeIntegration[]> {
  return db.integration.findMany({
    where: { userId },
    select: integrationSafeSelect,
    orderBy: { createdAt: "asc" },
  });
}

export async function getOwnedIntegration(db: Db, userId: string, integrationId: string) {
  return db.integration.findFirst({
    where: { id: integrationId, userId },
    select: integrationSafeSelect,
  });
}

/**
 * Connect the MOCK Google Tasks adapter (synthetic fixtures). Reconnecting reactivates the
 * existing record instead of creating a duplicate.
 */
export async function connectMockGoogleTasks(
  db: Db,
  userId: string,
  anchorDate: DateOnly,
  requestId?: string,
) {
  return db.$transaction(async (tx) => {
    const integration = await tx.integration.upsert({
      where: {
        userId_provider_externalAccountId: {
          userId,
          provider: "google_tasks",
          externalAccountId: "mock-account",
        },
      },
      create: {
        userId,
        provider: "google_tasks",
        mode: "mock",
        status: "active",
        externalAccountId: "mock-account",
        scopes: ["mock:tasks.readonly"],
        config: { mockAnchorDate: anchorDate },
      },
      update: {
        status: "active",
        disconnectedAt: null,
        connectedAt: new Date(),
        lastErrorCode: null,
      },
      select: integrationSafeSelect,
    });
    await recordAudit(tx, {
      userId,
      actor: "user",
      action: "integration.connected",
      targetType: "integration",
      targetId: integration.id,
      metadata: { provider: "google_tasks", mode: "mock" },
      requestId,
    });
    return integration;
  });
}

// ---- task lists ---------------------------------------------------------------------------

export async function listOwnedTaskLists(db: Db, userId: string, integrationId?: string) {
  return db.taskList.findMany({
    where: { userId, ...(integrationId ? { integrationId } : {}) },
    select: { id: true, integrationId: true, title: true, selected: true, available: true },
    orderBy: { title: "asc" },
  });
}

/** Set exactly which owned lists are selected. Unknown/foreign IDs are rejected. */
export async function setSelectedLists(
  db: Db,
  userId: string,
  integrationId: string,
  selectedListIds: string[],
  requestId?: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "invalid_list" }> {
  return db.$transaction(async (tx) => {
    const integration = await tx.integration.findFirst({
      where: { id: integrationId, userId },
      select: { id: true },
    });
    if (!integration) return { ok: false, reason: "not_found" } as const;
    const lists = await tx.taskList.findMany({
      where: { userId, integrationId },
      select: { id: true },
    });
    const owned = new Set(lists.map((l) => l.id));
    if (selectedListIds.some((id) => !owned.has(id))) {
      return { ok: false, reason: "invalid_list" } as const;
    }
    await tx.taskList.updateMany({ where: { userId, integrationId }, data: { selected: false } });
    if (selectedListIds.length > 0) {
      await tx.taskList.updateMany({
        where: { userId, integrationId, id: { in: selectedListIds } },
        data: { selected: true },
      });
    }
    await recordAudit(tx, {
      userId,
      actor: "user",
      action: "task_lists.selection_changed",
      targetType: "integration",
      targetId: integrationId,
      metadata: { selectedCount: selectedListIds.length },
      requestId,
    });
    return { ok: true } as const;
  });
}

// ---- tasks --------------------------------------------------------------------------------

export interface TaskView {
  id: string;
  title: string;
  notes: string | null;
  status: "needs_action" | "completed";
  dueDate: DateOnly | null;
  completedAt: Date | null;
  parentExternalId: string | null;
  hidden: boolean;
  deleted: boolean;
  webViewLink: string | null;
  syncedAt: Date;
  providerUpdatedAt: Date | null;
  list: { id: string; title: string };
  integration: { id: string; mode: "mock" | "live"; status: string };
  /** Opaque version for optimistic concurrency (changes whenever provider fields change). */
  versionHash: string;
  /** Student-confirmed Canvas assignment, if any (link survives even if the assignment
   * later becomes unavailable, which is shown). */
  link: {
    method: "url" | "suggested" | "manual";
    assignment: {
      id: string;
      title: string;
      dueAt: Date | null;
      htmlUrl: string | null;
      available: boolean;
      courseCode: string | null;
      courseName: string;
      integrationMode: "mock" | "live";
    };
  } | null;
  manualContext: { title: string; dueDate: DateOnly | null; dueAt: Date | null } | null;
}

const taskViewSelect = {
  id: true,
  title: true,
  notes: true,
  status: true,
  dueDate: true,
  completedAt: true,
  parentExternalId: true,
  hidden: true,
  deleted: true,
  webViewLink: true,
  syncedAt: true,
  providerUpdatedAt: true,
  taskList: { select: { id: true, title: true } },
  integration: { select: { id: true, mode: true, status: true } },
  versionHash: true,
  link: {
    select: {
      method: true,
      assignment: {
        select: {
          id: true,
          title: true,
          dueAt: true,
          htmlUrl: true,
          available: true,
          course: { select: { courseCode: true, name: true } },
          integration: { select: { mode: true, status: true } },
        },
      },
    },
  },
  manualContext: { select: { title: true, dueDate: true, dueAt: true } },
} as const;

type TaskRow = Prisma.TaskGetPayload<{ select: typeof taskViewSelect }>;

function toTaskView(row: TaskRow): TaskView {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    dueDate: row.dueDate ? dbDateToDateOnly(row.dueDate) : null,
    completedAt: row.completedAt,
    parentExternalId: row.parentExternalId,
    hidden: row.hidden,
    deleted: row.deleted,
    webViewLink: row.webViewLink,
    syncedAt: row.syncedAt,
    providerUpdatedAt: row.providerUpdatedAt,
    list: row.taskList,
    integration: row.integration,
    versionHash: row.versionHash,
    link:
      row.link && row.link.assignment.integration.status !== "disconnected"
        ? {
            method: row.link.method,
            assignment: {
              id: row.link.assignment.id,
              title: row.link.assignment.title,
              dueAt: row.link.assignment.dueAt,
              htmlUrl: row.link.assignment.htmlUrl,
              available: row.link.assignment.available,
              courseCode: row.link.assignment.course.courseCode,
              courseName: row.link.assignment.course.name,
              integrationMode: row.link.assignment.integration.mode,
            },
          }
        : null,
    manualContext: row.manualContext
      ? {
          title: row.manualContext.title,
          dueDate: row.manualContext.dueDate ? dbDateToDateOnly(row.manualContext.dueDate) : null,
          dueAt: row.manualContext.dueAt,
        }
      : null,
  };
}

/** Visible = not deleted, in a selected + available list, from a non-disconnected integration. */
const visibleTaskWhere = (userId: string): Prisma.TaskWhereInput => ({
  userId,
  deleted: false,
  taskList: { selected: true, available: true },
  integration: { status: { not: "disconnected" } },
});

export async function listDashboardTasks(db: Db, userId: string): Promise<TaskView[]> {
  const rows = await db.task.findMany({
    where: visibleTaskWhere(userId),
    select: taskViewSelect,
    orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { title: "asc" }],
    take: 1000,
  });
  return rows.map(toTaskView);
}

export interface TaskPageQuery {
  limit: number;
  cursor?: string;
  status?: "needs_action" | "completed";
  dueFrom?: DateOnly;
  dueTo?: DateOnly;
  listId?: string;
}

/** Keyset pagination ordered by id (stable across inserts). */
export async function listTasksPage(db: Db, userId: string, q: TaskPageQuery) {
  const where: Prisma.TaskWhereInput = {
    ...visibleTaskWhere(userId),
    ...(q.status ? { status: q.status } : {}),
    ...(q.listId ? { taskListId: q.listId } : {}),
    ...(q.dueFrom || q.dueTo
      ? {
          dueDate: {
            ...(q.dueFrom ? { gte: new Date(`${q.dueFrom}T00:00:00.000Z`) } : {}),
            ...(q.dueTo ? { lte: new Date(`${q.dueTo}T00:00:00.000Z`) } : {}),
          },
        }
      : {}),
    ...(q.cursor ? { id: { gt: q.cursor } } : {}),
  };
  const rows = await db.task.findMany({
    where,
    select: taskViewSelect,
    orderBy: { id: "asc" },
    take: q.limit + 1,
  });
  const hasMore = rows.length > q.limit;
  const items = rows.slice(0, q.limit).map(toTaskView);
  return { items, nextCursor: hasMore ? items[items.length - 1]!.id : null };
}

export async function getOwnedTask(
  db: Db,
  userId: string,
  taskId: string,
): Promise<TaskView | null> {
  const row = await db.task.findFirst({ where: { id: taskId, userId }, select: taskViewSelect });
  return row ? toTaskView(row) : null;
}

// ---- jobs and sync status -----------------------------------------------------------------

export async function getOwnedJob(db: Db, userId: string, jobId: string) {
  return db.job.findFirst({
    where: { id: jobId, userId },
    select: {
      id: true,
      kind: true,
      status: true,
      attempts: true,
      maxAttempts: true,
      lastErrorCode: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
      result: true,
    },
  });
}

export async function getActiveSyncJob(db: Db, userId: string, integrationId: string) {
  return db.job.findFirst({
    where: { userId, dedupeKey: syncDedupeKey(integrationId) },
    select: { id: true, status: true },
  });
}

export async function getLatestSyncRun(db: Db, userId: string, integrationId: string) {
  return db.syncRun.findFirst({
    where: { userId, integrationId },
    orderBy: { startedAt: "desc" },
    select: {
      id: true,
      status: true,
      trigger: true,
      startedAt: true,
      finishedAt: true,
      tasksFetched: true,
      tasksUpserted: true,
      tasksDeleted: true,
      safeErrorCode: true,
    },
  });
}

/** System-level (worker scheduler only): active Tasks/Canvas integrations of users with sync enabled. */
export async function listIntegrationsForScheduling(db: Db) {
  return db.integration.findMany({
    where: {
      status: "active",
      provider: { in: ["google_tasks", "canvas"] },
      user: { preference: { is: { syncEnabled: true } }, deletionRequestedAt: null },
    },
    select: { id: true, userId: true, provider: true, lastAttemptAt: true },
  });
}
