import "server-only";
import {
  approvedCanvasOrigins,
  connectMockCanvas,
  connectMockGoogleTasks,
  getTaskContext,
  listAssignmentsForMatching,
  enqueueJob,
  getOwnedIntegration,
  GOOGLE_TASKS_SYNC_JOB,
  recordAudit,
  syncDedupeKey,
} from "@scholar/db";
import {
  extractCanvasAssignmentRefs,
  rankCandidates,
  systemClock,
  todayInTimeZone,
} from "@scholar/domain";
import {
  CANVAS_SYNC_JOB,
  canvasOAuthFromEnv,
  disconnectIntegrationWithRevocation,
  googleTasksOAuthFromEnv,
  keyringFromEnv,
  startCanvasConnection,
  startGoogleTasksConnection,
  type CanvasConnectionDeps,
  type GoogleConnectionDeps,
  type ReturnPath,
} from "@scholar/services";
import { createGuardedFetch, createLogger } from "@scholar/security";
import { MOCK_CANVAS_ORIGIN } from "./mock-origins";
import { ApiError, notFound } from "./api";
import { db } from "./db";
import { serverEnv } from "./server-env";
import type { SessionUser } from "./session";

const logger = createLogger({ service: "web" });

/** Queue a sync for an owned, active integration. Deduplicated per integration. */
export async function requestSync(
  userId: string,
  integrationId: string,
  trigger: "manual" | "initial",
  requestId?: string,
) {
  const integration = await getOwnedIntegration(db(), userId, integrationId);
  if (!integration) throw notFound();
  if (integration.status !== "active") {
    throw new ApiError("conflict", `Integration is ${integration.status}; reconnect first`);
  }
  const job = await enqueueJob(db(), {
    userId,
    kind: integration.provider === "canvas" ? CANVAS_SYNC_JOB : GOOGLE_TASKS_SYNC_JOB,
    dedupeKey: syncDedupeKey(integration.id),
    payload: { integrationId: integration.id, trigger },
  });
  if (!job.deduplicated) {
    await recordAudit(db(), {
      userId,
      actor: "user",
      action: "sync.requested",
      targetType: "integration",
      targetId: integration.id,
      metadata: { trigger, jobId: job.id },
      requestId,
    });
  }
  return job;
}

/** Live Google connection dependencies, or null when live mode is not fully configured. */
export function googleConnectionDeps(): GoogleConnectionDeps | null {
  const env = serverEnv();
  const keyring = keyringFromEnv(env);
  const oauth = googleTasksOAuthFromEnv(env);
  if (env.integrationsMode !== "live" || !keyring || !oauth) return null;
  return {
    db: db(),
    keyring,
    oauth,
    fetch: (url, init) => fetch(url, init),
    clock: systemClock,
    appOrigin: env.appOrigin,
    logger,
  };
}

export type ConnectResult =
  | { kind: "connected"; integrationId: string; jobId: string; mode: "mock" }
  | { kind: "redirect"; authorizationUrl: string };

export async function connectGoogleTasks(
  user: SessionUser,
  timezone: string,
  returnPath: ReturnPath,
  requestId?: string,
): Promise<ConnectResult> {
  const env = serverEnv();
  if (env.integrationsMode === "mock") {
    const anchor = todayInTimeZone(new Date(), timezone);
    const integration = await connectMockGoogleTasks(db(), user.id, anchor, requestId);
    const job = await requestSync(user.id, integration.id, "initial", requestId);
    return { kind: "connected", integrationId: integration.id, jobId: job.id, mode: "mock" };
  }
  const deps = googleConnectionDeps();
  if (!deps) {
    // Never fall back to fixtures when the live connection cannot be made.
    throw new ApiError(
      "capability_unavailable",
      "Google Tasks connection is not configured on this server",
    );
  }
  const { authorizationUrl } = await startGoogleTasksConnection(deps, {
    userId: user.id,
    sessionId: user.sessionId,
    returnPath,
    requestId,
  });
  return { kind: "redirect", authorizationUrl };
}

export async function disconnect(
  userId: string,
  integrationId: string,
  deleteCachedData: boolean,
  requestId?: string,
) {
  const env = serverEnv();
  return disconnectIntegrationWithRevocation(
    {
      db: db(),
      keyring: keyringFromEnv(env),
      clock: systemClock,
      // Canvas revocation only ever goes to that integration's own approved origin.
      fetchFor: (provider, origin) =>
        provider === "canvas" && origin
          ? createGuardedFetch({ allowedOrigins: [origin] })
          : (url, init) => fetch(url, init),
    },
    { userId, integrationId, deleteCachedData, requestId },
  );
}

/** Live Canvas dependencies, or null when Canvas is not enabled/configured (manual mode). */
export function canvasConnectionDeps(): CanvasConnectionDeps | null {
  const env = serverEnv();
  const keyring = keyringFromEnv(env);
  const oauth = canvasOAuthFromEnv(env);
  if (!keyring || !oauth) return null;
  return {
    db: db(),
    keyring,
    oauth,
    fetch: createGuardedFetch({ allowedOrigins: [oauth.origin] }),
    clock: systemClock,
    appOrigin: env.appOrigin,
    logger,
  };
}

export type CanvasAvailability = "mock" | "live" | "unavailable";

export function canvasAvailability(): CanvasAvailability {
  const env = serverEnv();
  if (env.integrationsMode === "mock") return "mock";
  return canvasConnectionDeps() ? "live" : "unavailable";
}

export async function connectCanvas(
  user: SessionUser,
  timezone: string,
  returnPath: ReturnPath,
  requestId?: string,
): Promise<ConnectResult> {
  const availability = canvasAvailability();
  if (availability === "mock") {
    const anchor = todayInTimeZone(new Date(), timezone);
    const integration = await connectMockCanvas(
      db(),
      user.id,
      anchor,
      MOCK_CANVAS_ORIGIN,
      requestId,
    );
    const job = await requestSync(user.id, integration.id, "initial", requestId);
    return { kind: "connected", integrationId: integration.id, jobId: job.id, mode: "mock" };
  }
  const deps = canvasConnectionDeps();
  if (availability === "unavailable" || !deps) {
    throw new ApiError(
      "capability_unavailable",
      "Canvas connection unavailable: no institution-approved developer key is configured. Use manual assignment details instead.",
    );
  }
  const { authorizationUrl } = await startCanvasConnection(deps, {
    userId: user.id,
    sessionId: user.sessionId,
    returnPath,
    requestId,
  });
  return { kind: "redirect", authorizationUrl };
}

/** Ranked Canvas assignment candidates for an owned task. Never links anything. */
export async function linkCandidates(userId: string, taskId: string, timezone: string) {
  const ctx = await getTaskContext(db(), userId, taskId);
  if (!ctx) return null;
  const [origins, assignments] = await Promise.all([
    approvedCanvasOrigins(db(), userId),
    listAssignmentsForMatching(db(), userId),
  ]);
  const refs = extractCanvasAssignmentRefs(`${ctx.title}\n${ctx.notes ?? ""}`, origins);
  const candidates = rankCandidates(
    { title: ctx.title, notes: ctx.notes, dueDate: ctx.dueDate },
    assignments.map((a) => ({
      id: a.id,
      externalId: a.externalId,
      title: a.title,
      courseName: a.course.name,
      courseCode: a.course.courseCode,
      courseExternalId: a.course.externalId,
      dueDate: a.dueAt ? todayInTimeZone(a.dueAt, timezone) : null,
      available: a.available,
    })),
    refs,
  );
  const byId = new Map(assignments.map((a) => [a.id, a]));
  return {
    task: { id: ctx.id, versionHash: ctx.versionHash },
    canvasConnected: origins.length > 0,
    candidates: candidates.map((c) => {
      const a = byId.get(c.assignmentId)!;
      return {
        ...c,
        assignment: {
          id: a.id,
          title: a.title,
          dueAt: a.dueAt,
          courseName: a.course.name,
          courseCode: a.course.courseCode,
        },
      };
    }),
  };
}
