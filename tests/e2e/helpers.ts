import path from "node:path";
import { expect, type Browser, type Page, type TestInfo } from "@playwright/test";

export const DEMO_PASSWORD = "e2e-demo-password";
export const ALICE = "demo.student@scholar.example"; // America/New_York
export const BOB = "demo.second@scholar.example"; // Asia/Tokyo
const AUTH_DIR = path.join(import.meta.dirname, ".auth");
export const ALICE_STATE = path.join(AUTH_DIR, "alice.json");
export const BOB_STATE = path.join(AUTH_DIR, "bob.json");

/**
 * Sign in through the real UI. Better Auth rate-limits sign-in attempts; when that limit is
 * hit the form says so and we wait for the window to pass rather than weakening the limit.
 */
export async function signIn(page: Page, email: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto("/sign-in");
    await page.getByLabel("Demo account").selectOption(email);
    await page.getByLabel("Demo password").fill(DEMO_PASSWORD);
    await page.getByRole("button", { name: "Sign in as demo student" }).click();
    const outcome = await Promise.race([
      page.waitForURL(/\/(dashboard|onboarding)$/).then(() => "ok" as const),
      page
        .getByText("Too many sign-in attempts")
        .waitFor()
        .then(() => "limited" as const),
    ]);
    if (outcome === "ok") return;
    await page.waitForTimeout(11_000);
  }
  throw new Error("sign-in kept being rate limited");
}

export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/sign-in$/);
}

/** A page for a user whose session was stored by the setup project. */
export async function pageAs(browser: Browser, testInfo: TestInfo, state: string) {
  const context = await browser.newContext({
    storageState: state,
    baseURL: testInfo.project.use.baseURL,
  });
  return context.newPage();
}

/** Complete onboarding: connect mock Tasks, select the coursework list, import. */
export async function onboard(page: Page) {
  await page.goto("/onboarding");
  await page.getByRole("button", { name: /Connect mock Google Tasks/ }).click();
  await expect(page.getByLabel("Coursework (synthetic)")).toBeVisible({ timeout: 45_000 });
  await page.getByLabel("Coursework (synthetic)").check();
  await page.getByRole("button", { name: "Save list selection" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Imported" })).toBeVisible({
    timeout: 45_000,
  });
  await page.getByRole("button", { name: "Go to dashboard" }).click();
  await page.waitForURL(/\/dashboard$/);
}

export function sameOriginHeaders(page: Page) {
  return { "content-type": "application/json", origin: new URL(page.url()).origin };
}
