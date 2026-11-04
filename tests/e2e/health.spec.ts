import { expect, test } from "@playwright/test";

test("health endpoint reports database and worker without user data", async ({ request }) => {
  await expect
    .poll(async () => (await (await request.get("/api/health")).json()).status, { timeout: 45_000 })
    .toBe("ok");
  const body = await (await request.get("/api/health")).json();
  expect(body).toMatchObject({
    status: "ok",
    database: "ok",
    worker: { status: "ok" },
    integrationsMode: "mock",
  });
  expect(Object.keys(body).sort()).toEqual(["database", "integrationsMode", "status", "worker"]);
});
