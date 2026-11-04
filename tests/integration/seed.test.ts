import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { verifyPassword } from "better-auth/crypto";
import { DEMO_USERS } from "@scholar/db";
import { seedDemo } from "../../packages/db/src/seed-demo.ts";
import { resetDatabase, testDb } from "../support/db-helpers.ts";

const db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDatabase(db));

describe("demo seed", () => {
  it("is idempotent and creates only synthetic accounts", async () => {
    await seedDemo(db, "pw-one-local");
    await seedDemo(db, "pw-one-local");
    expect(await db.user.count()).toBe(DEMO_USERS.length);
    expect(await db.account.count()).toBe(DEMO_USERS.length);
    expect(await db.integration.count()).toBe(0);
    for (const u of await db.user.findMany())
      expect(u.email.endsWith("@scholar.example")).toBe(true);
  });

  it("rotates the demo password hash when the configured password changes", async () => {
    await seedDemo(db, "pw-one-local");
    await seedDemo(db, "pw-two-local");
    const acct = await db.account.findFirstOrThrow({ where: { providerId: "credential" } });
    expect(await verifyPassword({ hash: acct.password!, password: "pw-two-local" })).toBe(true);
  });
});
