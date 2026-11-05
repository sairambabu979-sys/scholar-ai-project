/**
 * Google Tasks read-only synchronization (SCHOLAR_AI_PLAN.md §4.2).
 *
 *  - Task lists: complete paginated scan each run; a list missing from a COMPLETE scan is
 *    marked unavailable (never on partial scans).
 *  - Tasks (selected lists only): every page of a list is fetched before anything is written.
 *    The list's upserts, tombstones and cursor advance commit in one transaction, so a failure
 *    mid-pagination leaves the previous state and cursor untouched.
 *  - Upserts are keyed by provider identity (integration, external id) — never by title — and
 *    skipped when the normalized version hash is unchanged.
 *  - Disappearance is inferred only after a complete full scan; incremental reads only apply
 *    explicit tombstones.
 *  - Before every provider call the job re-checks that the integration is still active and the
 *    job was not cancelled (disconnect stops work promptly).
 */
import type { Db } from "@scholar/db";
import { recordAudit } from "@scholar/db";
import {
  chooseSyncMode,
  dateOnlyToDbDate,
  disappearedIds,
  incrementalUpdatedMin,
  nextWatermark,
  normalizeProviderTask,
  type Clock,
  type NormalizedTask,
  type SyncMode,
} from "@scholar/domain";
import {
  googleTaskListPageSchema,
  googleTaskPageSchema,
  ProviderError,
  type GoogleTask,
  type GoogleTaskList,
  type GoogleTasksReadClient,
} from "@scholar/integrations";
import type { Logger } from "@scholar/security";

export const TASK_LIST_STREAM = "google_task_list";
/** Hard bound per list; protects memory while staging a list's pages. */
const MAX_PAGES_PER_LIST = 200;

export class SyncCancelledError extends Error {
  constructor(readonly reason: "integration_inactive" | "job_cancelled") {
    super(reason);
    this.name = "SyncCancelledError";
  }
}

export interface SyncDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  /** Build the provider client for this integration (mock or live). */
  clientFor(integration: {
    id: string;
    userId: string;
    mode: "mock" | "live";
    config: unknown;
  }): Promise<GoogleTasksReadClient>;
  /** Cooperative cancellation checkpoint (e.g. job cancel flag). */
  isCancelled?: () => Promise<boolean>;
}

export interface SyncInput {
  userId: string;
  integrationId: string;
  trigger: "manual" | "scheduled" | "initial";
  jobId?: string;
}

export interface SyncSummary {
  syncRunId: string;
  status: "succeeded" | "cancelled";
  listsSeen: number;
  pagesFetched: number;
  tasksFetched: number;
  tasksUpserted: number;
  tasksUnchanged: number;
  tasksDeleted: number;
  modes: Record<string, SyncMode>;
}

export async function runGoogleTasksSync(deps: SyncDeps, input: SyncInput): Promise<SyncSummary> {
  const { db, clock } = deps;
  const integration = await db.integration.findFirst({
    where: { id: input.integrationId, userId: input.userId, provider: "google_tasks" },
    select: { id: true, userId: true, mode: true, status: true, config: true },
  });
  if (!integration) throw new ProviderError("not_found", "integration_not_found");
  if (integration.status !== "active") throw new SyncCancelledError("integration_inactive");

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

  const counters = {
    listsSeen: 0,
    pagesFetched: 0,
    tasksFetched: 0,
    tasksUpserted: 0,
    tasksUnchanged: 0,
    tasksDeleted: 0,
  };
  const modes: Record<string, SyncMode> = {};

  const checkpoint = async () => {
    const current = await db.integration.findUnique({
      where: { id: integration.id },
      select: { status: true },
    });
    if (current?.status !== "active") throw new SyncCancelledError("integration_inactive");
    if (deps.isCancelled && (await deps.isCancelled()))
      throw new SyncCancelledError("job_cancelled");
  };

  try {
    const client = await deps.clientFor({
      id: integration.id,
      userId: integration.userId,
      mode: integration.mode,
      config: integration.config,
    });

    // ---- 1. task lists (complete scan) ----------------------------------------------------
    const lists: GoogleTaskList[] = [];
    let pageToken: string | undefined;
    let pages = 0;
    do {
      await checkpoint();
      const page = googleTaskListPageSchema.parse(await client.listTaskLists({ pageToken }));
      counters.pagesFetched++;
      lists.push(...page.items);
      pageToken = page.nextPageToken;
      if (++pages > MAX_PAGES_PER_LIST) throw new ProviderError("fatal", "too_many_pages");
    } while (pageToken);
    counters.listsSeen = lists.length;

    const now = clock.now();
    await db.$transaction(async (tx) => {
      for (const l of lists) {
        await tx.taskList.upsert({
          where: { integrationId_externalId: { integrationId: integration.id, externalId: l.id } },
          create: {
            userId: input.userId,
            integrationId: integration.id,
            externalId: l.id,
            title: l.title.slice(0, 1024),
            etag: l.etag,
            providerUpdatedAt: l.updated ? new Date(l.updated) : null,
            lastSeenAt: now,
          },
          update: {
            title: l.title.slice(0, 1024),
            etag: l.etag,
            providerUpdatedAt: l.updated ? new Date(l.updated) : null,
            available: true,
            lastSeenAt: now,
          },
        });
      }
      // Complete scan finished: lists no longer returned are unavailable (not deleted).
      await tx.taskList.updateMany({
        where: {
          userId: input.userId,
          integrationId: integration.id,
          externalId: { notIn: lists.map((l) => l.id) },
        },
        data: { available: false },
      });
    });

    // ---- 2. tasks for each selected list --------------------------------------------------
    const selected = await db.taskList.findMany({
      where: {
        userId: input.userId,
        integrationId: integration.id,
        selected: true,
        available: true,
      },
      select: { id: true, externalId: true },
    });

    for (const list of selected) {
      const cursor = await db.syncCursor.findUnique({
        where: {
          integrationId_resourceKind_resourceId: {
            integrationId: integration.id,
            resourceKind: TASK_LIST_STREAM,
            resourceId: list.externalId,
          },
        },
        select: { watermark: true, lastFullReconciliationAt: true },
      });
      const mode = chooseSyncMode(cursor, clock.now());
      modes[list.externalId] = mode;
      const updatedMin =
        mode === "incremental" && cursor?.watermark
          ? incrementalUpdatedMin(cursor.watermark).toISOString()
          : undefined;

      // Stage every page before writing anything.
      const fetched: GoogleTask[] = [];
      let token: string | undefined;
      let listPages = 0;
      do {
        await checkpoint();
        const page = googleTaskPageSchema.parse(
          await client.listTasks(list.externalId, {
            pageToken: token,
            updatedMin,
            showCompleted: true,
            showHidden: true,
            showDeleted: true,
            maxResults: 100,
          }),
        );
        counters.pagesFetched++;
        fetched.push(...page.items);
        token = page.nextPageToken;
        if (++listPages > MAX_PAGES_PER_LIST) throw new ProviderError("fatal", "too_many_pages");
      } while (token);
      counters.tasksFetched += fetched.length;

      // Normalize (validates dates etc.) before opening the transaction. Duplicates from the
      // overlap window collapse to the newest version.
      const byId = new Map<string, NormalizedTask>();
      for (const raw of fetched) {
        const n = normalizeProviderTask(raw);
        const prev = byId.get(n.externalId);
        if (!prev || prev.providerUpdatedAt <= n.providerUpdatedAt) byId.set(n.externalId, n);
      }

      await checkpoint();
      const commitAt = clock.now();
      const result = await db.$transaction(
        async (tx) => {
          const existing = await tx.task.findMany({
            where: { integrationId: integration.id, externalId: { in: [...byId.keys()] } },
            select: { id: true, externalId: true, versionHash: true, taskListId: true },
          });
          const existingMap = new Map(existing.map((e) => [e.externalId, e]));
          let upserted = 0;
          let unchanged = 0;
          for (const n of byId.values()) {
            const data = {
              taskListId: list.id,
              title: n.title,
              notes: n.notes,
              parentExternalId: n.parentExternalId,
              position: n.position,
              status: n.status,
              dueDate: n.dueDate ? dateOnlyToDbDate(n.dueDate) : null,
              completedAt: n.completedAt ? new Date(n.completedAt) : null,
              hidden: n.hidden,
              deleted: n.deleted,
              webViewLink: n.webViewLink,
              providerUpdatedAt: new Date(n.providerUpdatedAt),
              etag: n.etag,
              versionHash: n.versionHash,
              syncedAt: commitAt,
            };
            const prev = existingMap.get(n.externalId);
            if (!prev) {
              await tx.task.create({
                data: {
                  ...data,
                  userId: input.userId,
                  integrationId: integration.id,
                  externalId: n.externalId,
                },
              });
              upserted++;
            } else if (prev.versionHash !== n.versionHash || prev.taskListId !== list.id) {
              await tx.task.update({ where: { id: prev.id }, data });
              upserted++;
            } else {
              unchanged++;
            }
          }
          if (unchanged > 0) {
            await tx.task.updateMany({
              where: {
                integrationId: integration.id,
                externalId: {
                  in: [...byId.values()]
                    .filter((n) => existingMap.get(n.externalId)?.versionHash === n.versionHash)
                    .map((n) => n.externalId),
                },
              },
              data: { syncedAt: commitAt },
            });
          }

          // Disappearance: only after this complete full scan of the list.
          let deletedCount = 0;
          if (mode === "full") {
            const local = await tx.task.findMany({
              where: { integrationId: integration.id, taskListId: list.id, deleted: false },
              select: { externalId: true },
            });
            const gone = disappearedIds(
              local.map((l) => l.externalId),
              new Set(byId.keys()),
              { mode, complete: true },
            );
            if (gone.length > 0) {
              const r = await tx.task.updateMany({
                where: { integrationId: integration.id, externalId: { in: gone } },
                data: { deleted: true, syncedAt: commitAt },
              });
              deletedCount = r.count;
            }
          }

          // Advance the cursor only now, inside the same commit.
          const watermark = nextWatermark(
            cursor?.watermark ?? null,
            [...byId.values()].map((n) => n.providerUpdatedAt),
          );
          await tx.syncCursor.upsert({
            where: {
              integrationId_resourceKind_resourceId: {
                integrationId: integration.id,
                resourceKind: TASK_LIST_STREAM,
                resourceId: list.externalId,
              },
            },
            create: {
              userId: input.userId,
              integrationId: integration.id,
              resourceKind: TASK_LIST_STREAM,
              resourceId: list.externalId,
              watermark,
              lastFullReconciliationAt: mode === "full" ? commitAt : null,
            },
            update: {
              watermark,
              ...(mode === "full" ? { lastFullReconciliationAt: commitAt } : {}),
            },
          });
          return { upserted, unchanged, deletedCount };
        },
        { timeout: 60_000 },
      );
      counters.tasksUpserted += result.upserted;
      counters.tasksUnchanged += result.unchanged;
      counters.tasksDeleted += result.deletedCount;
    }

    const finishedAt = clock.now();
    await db.$transaction([
      db.syncRun.update({
        where: { id: run.id },
        data: { status: "succeeded", finishedAt, ...counters },
      }),
      db.integration.update({
        where: { id: integration.id },
        data: { lastSuccessAt: finishedAt, lastErrorCode: null, lastErrorAt: null },
      }),
    ]);
    deps.logger.info("google_tasks.sync.succeeded", {
      integrationId: integration.id,
      syncRunId: run.id,
      ...counters,
    });
    return { syncRunId: run.id, status: "succeeded", modes, ...counters };
  } catch (error) {
    const finishedAt = clock.now();
    if (error instanceof SyncCancelledError) {
      await db.syncRun.update({
        where: { id: run.id },
        data: { status: "cancelled", finishedAt, safeErrorCode: error.reason, ...counters },
      });
      deps.logger.info("google_tasks.sync.cancelled", {
        integrationId: integration.id,
        reason: error.reason,
      });
      return { syncRunId: run.id, status: "cancelled", modes, ...counters };
    }
    const code =
      error instanceof ProviderError
        ? error.code
        : error instanceof RangeError
          ? "invalid_provider_data"
          : (error as { name?: string })?.name === "ZodError"
            ? "invalid_provider_response"
            : "internal_error";
    await db.syncRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt, safeErrorCode: code, ...counters },
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
    deps.logger.warn("google_tasks.sync.failed", {
      integrationId: integration.id,
      code,
      errorName: (error as { name?: string })?.name,
    });
    throw error instanceof ProviderError ? error : new ProviderError("fatal", code);
  }
}
