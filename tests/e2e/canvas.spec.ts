import { expect, test } from "@playwright/test";
import { ALICE_STATE } from "./helpers.ts";

test.describe.configure({ mode: "serial" });
test.use({ storageState: ALICE_STATE });

const openTask = async (page: import("@playwright/test").Page, title: string) => {
  await page.goto("/dashboard");
  await page.getByRole("link", { name: title }).first().click();
  await expect(page.getByTestId("task-title")).toHaveText(title);
};

test("connect mock Canvas and confirm the exact assignment for a task", async ({ page }) => {
  await page.goto("/onboarding");
  await page.getByRole("button", { name: "Connect mock Canvas (synthetic data)" }).click();
  // The card re-renders into its connected state once the worker's first sync finishes.
  await expect(page.getByTestId("canvas-connected")).toBeVisible({ timeout: 45_000 });
  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByTestId("canvas-connected").innerText();
      },
      { timeout: 45_000 },
    )
    .toContain("4 courses imported");

  await openTask(page, "BIO 110 — Lab report: enzyme kinetics");
  const candidates = page.getByTestId("link-candidate");
  await expect(candidates.first()).toContainText("Lab Report: Enzyme Kinetics");
  await expect(candidates.first()).toContainText("Exact match");
  await expect(page.getByText("Nothing is linked until you confirm one.")).toBeVisible();
  await candidates.first().getByRole("button", { name: "Confirm this assignment" }).click();

  const detail = page.getByTestId("assignment-detail");
  await expect(detail).toContainText("Lab Report: Enzyme Kinetics");
  await expect(page.getByTestId("submission-status")).toContainText("Not submitted");
  const description = page.getByTestId("assignment-description");
  await expect(description).toContainText("Write up the enzyme kinetics lab");
  await expect(description).not.toContainText("document.location");
  await expect(description).not.toContainText("javascript");
  await expect(page.getByTestId("open-in-canvas")).toHaveAttribute(
    "href",
    "https://canvas.school.example/courses/1101/assignments/50011",
  );
  await expect(page.getByTestId("effective-deadline")).toContainText("from Canvas");
});

test("a Canvas override that disagrees with Google Tasks is shown, not hidden (A09)", async ({
  page,
}) => {
  await openTask(page, "ENG 102 — Essay draft: argument outline");
  await page
    .getByTestId("link-candidate")
    .first()
    .getByRole("button", { name: "Confirm this assignment" })
    .click();
  await expect(page.getByTestId("deadline-conflict")).toContainText("Google Tasks says");
  await expect(page.getByTestId("submission-status")).toContainText(
    "not allowed to read submission status",
  );
  await page.goto("/dashboard");
  const item = page.getByTestId("task-item").filter({ hasText: "ENG 102 — Essay draft" });
  await expect(item.getByTestId("due-source")).toContainText("from Canvas");
  await expect(item.getByTestId("due-conflict")).toContainText("Google Tasks says");
});

test("ambiguous titles get several suggestions and nothing is linked automatically (A10)", async ({
  page,
}) => {
  await openTask(page, "MATH 221 — Problem set 7");
  const candidates = page.getByTestId("link-candidate");
  await expect(candidates).toHaveCount(2);
  await expect(candidates.nth(0)).toContainText("Suggestion");
  await expect(page.getByTestId("assignment-detail")).toHaveCount(0);
});

test("manual assignment details work for tasks Canvas does not know about (A08)", async ({
  page,
}) => {
  await openTask(page, "Email TA about office hours");
  await page.getByLabel("Assignment title").fill("Office hours question");
  await page
    .getByLabel("Requirements (paste from the syllabus or assignment sheet)")
    .fill("Ask about the lab rubric weighting.");
  await page
    .getByLabel("Source links (https, one per line — shown to you, never fetched)")
    .fill("https://school.example/syllabus");
  await page.getByLabel("Due date override (optional)").fill("2026-12-01");
  await page.getByRole("button", { name: "Add details" }).click();
  await expect(page.getByRole("button", { name: "Save details" })).toBeVisible();
  await expect(page.getByTestId("effective-deadline")).toContainText("from your override");
  await expect(page.getByTestId("manual-sources")).toContainText("https://school.example/syllabus");
  await page.goto("/dashboard");
  await expect(
    page
      .getByTestId("task-item")
      .filter({ hasText: "Email TA" })
      .getByTestId("manual-context-badge"),
  ).toContainText("Office hours question");
});

test("another student cannot use this student's assignment ids", async ({
  page,
  browser,
}, testInfo) => {
  const assignments = await (await page.request.get("/api/v1/assignments?limit=5")).json();
  const assignmentId: string = assignments.data.items[0].id;
  const { BOB_STATE } = await import("./helpers.ts");
  const ctx = await browser.newContext({
    storageState: BOB_STATE,
    baseURL: testInfo.project.use.baseURL,
  });
  const bob = await ctx.newPage();
  await bob.goto("/settings");
  expect((await (await bob.request.get("/api/v1/assignments")).json()).data.items).toEqual([]);
  const tasks = await (await page.request.get("/api/v1/tasks?limit=1")).json();
  const res = await bob.request.put(`/api/v1/tasks/${tasks.data.items[0].id}/link`, {
    headers: { "content-type": "application/json", origin: new URL(bob.url()).origin },
    data: { assignmentId, method: "manual", expectedTaskVersion: "x" },
  });
  expect(res.status()).toBe(404);
});
