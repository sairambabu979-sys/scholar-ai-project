import { expect, test } from "@playwright/test";
import { testDb } from "../support/db-helpers.ts";
import { ALICE_STATE, BOB_STATE, onboard, pageAs, sameOriginHeaders } from "./helpers.ts";

test.describe.configure({ mode: "serial" });

test("student connects mock Tasks, imports a list, and sees a persisted dashboard", async ({
  browser,
}, testInfo) => {
  const page = await pageAs(browser, testInfo, ALICE_STATE);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByTestId("canvas-unavailable")).toBeVisible();
  await onboard(page);

  await expect(page.getByTestId("mock-banner")).toBeVisible();
  await expect(page.getByTestId("today-line")).toContainText("America/New_York");
  await expect(
    page.getByTestId("bucket-today").getByText("BIO 110 — Lab report: enzyme kinetics"),
  ).toBeVisible();
  await expect(
    page.getByTestId("bucket-overdue").getByText("MATH 221 — Problem set 6"),
  ).toBeVisible();
  await expect(
    page.getByTestId("bucket-upcoming").getByText("MATH 221 — Problem set 7"),
  ).toBeVisible();
  // Deleted tasks and unselected lists are not shown.
  await expect(page.getByText("CHEM 101 — Dropped course reminder")).toHaveCount(0);
  await expect(page.getByText("Buy groceries")).toHaveCount(0);
  // Instruction-like notes render as inert text (A14).
  await expect(page.getByText(/IGNORE ALL PREVIOUS INSTRUCTIONS/)).toBeVisible();
  await expect(page.getByTestId("sync-status")).toContainText("Up to date");

  await page.reload();
  await expect(
    page.getByTestId("bucket-today").getByText("BIO 110 — Lab report: enzyme kinetics"),
  ).toBeVisible();

  await page.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Synced" })).toBeVisible({
    timeout: 45_000,
  });
});

test("a second student cannot see or act on the first student's data (A01)", async ({
  browser,
}, testInfo) => {
  const alice = await pageAs(browser, testInfo, ALICE_STATE);
  await alice.goto("/dashboard");
  const aliceTaskId: string = (await (await alice.request.get("/api/v1/tasks?limit=100")).json())
    .data.items[0].id;
  const aliceIntegrationId: string = (
    await (await alice.request.get("/api/v1/integrations")).json()
  ).data[0].id;

  const bob = await pageAs(browser, testInfo, BOB_STATE);
  await bob.goto("/dashboard");
  await expect(bob).toHaveURL(/\/onboarding$/);
  expect((await (await bob.request.get("/api/v1/tasks?limit=100")).json()).data.items).toEqual([]);
  expect((await bob.request.get(`/api/v1/tasks/${aliceTaskId}`)).status()).toBe(404);
  const sync = await bob.request.post(`/api/v1/integrations/${aliceIntegrationId}/sync`, {
    headers: sameOriginHeaders(bob),
    data: {},
  });
  expect(sync.status()).toBe(404);
  const del = await bob.request.delete(`/api/v1/integrations/${aliceIntegrationId}`, {
    headers: sameOriginHeaders(bob),
    data: { deleteCachedData: true },
  });
  expect(del.status()).toBe(404);
  // Alice's data is untouched.
  expect((await alice.request.get(`/api/v1/tasks/${aliceTaskId}`)).status()).toBe(200);
});

test("the same Google due date displays as the same day in New York and Tokyo (A04)", async ({
  browser,
}, testInfo) => {
  const bob = await pageAs(browser, testInfo, BOB_STATE);
  await onboard(bob);
  await expect(bob.getByTestId("today-line")).toContainText("Asia/Tokyo");

  // Give both students' copies of one fixture the stored Google value 2026-11-05T00:00:00.000Z.
  const db = testDb();
  try {
    await db.$executeRaw`UPDATE tasks SET due_date = DATE '2026-11-05' WHERE external_id = 'mock-task-005'`;
  } finally {
    await db.$disconnect();
  }
  const alice = await pageAs(browser, testInfo, ALICE_STATE);
  for (const page of [alice, bob]) {
    await page.goto("/dashboard");
    const item = page
      .getByTestId("task-item")
      .filter({ hasText: "MATH 221 — Midterm exam review" });
    await expect(item.getByTestId("due-label")).toContainText("Nov 5, 2026");
    const api = await (await page.request.get("/api/v1/tasks?limit=100")).json();
    const task = api.data.items.find(
      (t: { title: string }) => t.title === "MATH 221 — Midterm exam review",
    );
    expect(task.dueDate).toBe("2026-11-05");
  }
});

test("disconnect stops syncing and can delete imported data (A26)", async ({
  browser,
}, testInfo) => {
  const bob = await pageAs(browser, testInfo, BOB_STATE);
  await bob.goto("/settings");
  await bob.getByRole("button", { name: "Disconnect…" }).click();
  await bob.getByLabel("Also delete imported tasks and lists from Scholar AI").check();
  await bob.getByRole("button", { name: "Confirm disconnect" }).click();
  await expect(bob.getByRole("button", { name: /Connect mock Google Tasks/ })).toBeVisible();
  expect((await (await bob.request.get("/api/v1/tasks?limit=100")).json()).data.items).toEqual([]);
  const integrations = (await (await bob.request.get("/api/v1/integrations")).json()).data;
  expect(integrations[0].status).toBe("disconnected");
});
