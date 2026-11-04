import "server-only";
import {
  getActiveSyncJob,
  getLatestSyncRun,
  getProfile,
  listIntegrations,
  listOwnedTaskLists,
} from "@scholar/db";
import { syncFreshness } from "@scholar/domain";
import { db } from "./db";
import { serverEnv } from "./server-env";

/** Everything the authenticated pages need about the owner's account, owner-scoped. */
export async function loadAccountState(userId: string) {
  const env = serverEnv();
  const profile = await getProfile(db(), userId);
  if (!profile) throw new Error("profile missing for session user");
  const integrations = await listIntegrations(db(), userId);
  const lists = await listOwnedTaskLists(db(), userId);
  const now = new Date();
  const googleTasks = await Promise.all(
    integrations
      .filter((i) => i.provider === "google_tasks")
      .map(async (i) => ({
        ...i,
        taskLists: lists.filter((l) => l.integrationId === i.id),
        latestRun: await getLatestSyncRun(db(), userId, i.id),
        activeJob: await getActiveSyncJob(db(), userId, i.id),
        freshness: syncFreshness({
          now,
          intervalSeconds: env.syncIntervalSeconds,
          lastSuccessAt: i.lastSuccessAt,
          lastErrorAt: i.lastErrorAt,
        }),
      })),
  );
  const activeGoogle = googleTasks.find((i) => i.status !== "disconnected") ?? null;
  return { env, profile, googleTasks, activeGoogle, now };
}
