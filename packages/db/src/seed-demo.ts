/**
 * Idempotent SYNTHETIC demo seed (mock mode only). Creates two demo students in different
 * timezones so date handling and two-user isolation can be exercised. No real coursework,
 * no provider connections. Refuses to run in production or live mode.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { loadEnvFiles } from "@scholar/config/load-env";
import { parseEnv } from "@scholar/config";
import { createPrismaClient, type Db } from "./client.ts";

export { DEMO_USERS } from "./demo-users.ts";
import { DEMO_USERS } from "./demo-users.ts";

export async function seedDemo(db: Db, demoPassword: string): Promise<{ users: number }> {
  for (const u of DEMO_USERS) {
    const user = await db.user.upsert({
      where: { email: u.email },
      create: { email: u.email, name: u.name, emailVerified: true, timezone: u.timezone },
      update: { name: u.name },
      select: { id: true },
    });
    const existing = await db.account.findFirst({
      where: { userId: user.id, providerId: "credential" },
      select: { id: true, password: true },
    });
    if (!existing) {
      await db.account.create({
        data: {
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password: await hashPassword(demoPassword),
        },
      });
    } else if (
      !existing.password ||
      !(await verifyPassword({ hash: existing.password, password: demoPassword }))
    ) {
      await db.account.update({
        where: { id: existing.id },
        data: { password: await hashPassword(demoPassword) },
      });
    }
    await db.preference.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
    });
  }
  return { users: DEMO_USERS.length };
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  loadEnvFiles(path.resolve(here, "../../.."));
  const { env } = parseEnv(process.env);
  if (env.isProduction || env.integrationsMode !== "mock" || !env.demoPassword) {
    throw new Error("Demo seed runs only in non-production mock mode");
  }
  const db = createPrismaClient(env.databaseUrl);
  try {
    const result = await seedDemo(db, env.demoPassword);
    console.log(`Seeded ${result.users} synthetic demo users (idempotent).`);
  } finally {
    await db.$disconnect();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
