import "server-only";
import {
  connectMockGoogleTasks,
  enqueueJob,
  getOwnedIntegration,
  GOOGLE_TASKS_SYNC_JOB,
  recordAudit,
  syncDedupeKey,
} from "@scholar/db";
import { todayInTimeZone } from "@scholar/domain";
import { ApiError, notFound } from "./api";
import { db } from "./db";
import { serverEnv } from "./server-env";

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

export async function connectGoogleTasks(userId: string, timezone: string, requestId?: string) {
  const env = serverEnv();
  if (env.integrationsMode !== "mock") {
    // Phase 2 (M1) implements the real read-only OAuth flow. Never fall back to fixtures.
    throw new ApiError(
      "capability_unavailable",
      "Live Google Tasks connection is not implemented yet (Phase 2)",
    );
  }
  const anchor = todayInTimeZone(new Date(), timezone);
  const integration = await connectMockGoogleTasks(db(), userId, anchor, requestId);
  const job = await requestSync(userId, integration.id, "initial", requestId);
  return { integration, jobId: job.id };
}
