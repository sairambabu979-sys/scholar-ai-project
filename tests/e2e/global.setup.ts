import { execFileSync } from "node:child_process";
import path from "node:path";
import { test as setup } from "@playwright/test";
import { seedDemo } from "../../packages/db/src/seed-demo.ts";
import { repoRoot, testDatabaseUrl } from "../support/test-db.ts";
import { resetDatabase, testDb } from "../support/db-helpers.ts";
import { ALICE, ALICE_STATE, BOB, BOB_STATE, DEMO_PASSWORD, signIn } from "./helpers.ts";

setup(
  "reset test database, seed synthetic users, sign each in once",
  async ({ browser }, testInfo) => {
    const url = testDatabaseUrl();
    execFileSync(
      process.execPath,
      [path.join(repoRoot, "node_modules/prisma/build/index.js"), "migrate", "deploy"],
      {
        cwd: path.join(repoRoot, "packages/db"),
        env: { ...process.env, DATABASE_URL: url },
        stdio: "inherit",
      },
    );
    const db = testDb();
    try {
      await resetDatabase(db);
      await seedDemo(db, DEMO_PASSWORD);
    } finally {
      await db.$disconnect();
    }
    for (const [email, state] of [
      [ALICE, ALICE_STATE],
      [BOB, BOB_STATE],
    ] as const) {
      const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
      const page = await context.newPage();
      await signIn(page, email);
      await context.storageState({ path: state });
      await context.close();
    }
  },
);
