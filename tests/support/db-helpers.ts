import { createPrismaClient, type Db } from "@scholar/db";
import { createLogger } from "@scholar/security";
import { testDatabaseUrl } from "./test-db.ts";

export function testDb(): Db {
  return createPrismaClient(testDatabaseUrl());
}

/** Wipe all application tables (test database only). */
export async function resetDatabase(db: Db): Promise<void> {
  await db.$executeRawUnsafe(`
    TRUNCATE TABLE audit_events, jobs, sync_cursors, sync_runs, tasks, task_lists, integrations,
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
