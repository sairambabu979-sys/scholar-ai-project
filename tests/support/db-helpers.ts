import { createPrismaClient, type Db } from "@scholar/db";
import { disconnectIntegrationWithRevocation } from "@scholar/services";
import { createLogger } from "@scholar/security";
import { testDatabaseUrl } from "./test-db.ts";

export function testDb(): Db {
  return createPrismaClient(testDatabaseUrl());
}

/** Wipe all application tables (test database only). */
export async function resetDatabase(db: Db): Promise<void> {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE audit_events, jobs, oauth_states, token_envelopes, task_links, manual_contexts,
      submission_snapshots, assignments, courses, sync_cursors, sync_runs,
      tasks, task_lists, integrations,
      preferences, sessions, auth_accounts, verifications, worker_heartbeats, users
    RESTART IDENTITY CASCADE`);
}

export async function createUser(db: Db, email: string, timezone = "UTC") {
  const user = await db.user.create({ data: { email, name: email.split("@")[0]!, timezone } });
  await db.preference.create({ data: { userId: user.id } });
  return user;
}

export async function createMockIntegration(db: Db, userId: string, anchorDate = "2026-11-04") {
  return db.integration.create({
    data: {
      userId,
      provider: "google_tasks",
      mode: "mock",
      externalAccountId: "mock-account",
      scopes: ["mock:tasks.readonly"],
      config: { mockAnchorDate: anchorDate },
    },
  });
}

export const silentLogger = createLogger({}, "error", () => undefined);

/** A fetch that fails the test if anything tries to reach the network. */
export const noNetwork = async (url: string): Promise<Response> => {
  throw new Error(`unexpected network call to ${new URL(url).host}`);
};

/** Disconnect through the production code path (mock integrations: no network, no keyring). */
export function disconnect(
  db: Db,
  userId: string,
  integrationId: string,
  deleteCachedData: boolean,
  now = new Date(),
) {
  return disconnectIntegrationWithRevocation(
    { db, keyring: null, fetchFor: () => noNetwork, clock: { now: () => now } },
    { userId, integrationId, deleteCachedData },
  );
}
