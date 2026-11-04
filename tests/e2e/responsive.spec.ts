import { expect, test } from "@playwright/test";
import { ALICE_STATE } from "./helpers.ts";

test.use({ storageState: ALICE_STATE });

test("dashboard is usable at phone width without horizontal scrolling (A28)", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

test("primary controls are reachable by keyboard with visible focus (A28)", async ({ page }) => {
  await page.goto("/dashboard");
  const sync = page.getByRole("button", { name: "Sync now" });
  await expect(sync).toBeVisible();
  for (let i = 0; i < 30 && !(await sync.evaluate((el) => el === document.activeElement)); i++) {
    await page.keyboard.press("Tab");
  }
  await expect(sync).toBeFocused();
  expect(await sync.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe("none");
});
