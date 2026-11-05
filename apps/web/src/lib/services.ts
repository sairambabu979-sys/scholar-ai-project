import "server-only";
import {
  connectMockGoogleTasks,
  enqueueJob,
  getOwnedIntegration,
  GOOGLE_TASKS_SYNC_JOB,
  recordAudit,
  syncDedupeKey,
} from "@scholar/db";
import { systemClock, todayInTimeZone } from "@scholar/domain";
import {
  disconnectIntegrationWithRevocation,
  googleTasksOAuthFromEnv,
  keyringFromEnv,
  startGoogleTasksConnection,
  type GoogleConnectionDeps,
  type ReturnPath,
} from "@scholar/services";
import { createLogger } from "@scholar/security";
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
    kind: GOOGLE_TASKS_SYNC_JOB,
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
      fetch: (url, init) => fetch(url, init),
      clock: systemClock,
    },
    { userId, integrationId, deleteCachedData, requestId },
  );
}
