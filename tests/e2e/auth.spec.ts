import { expect, test } from "@playwright/test";
import { ALICE, ALICE_STATE, pageAs, signIn, signOut } from "./helpers.ts";

test("unauthenticated pages redirect to sign-in", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByTestId("mock-banner")).toBeVisible();
});

test("unauthenticated API calls are rejected without data (A01)", async ({ request }) => {
  for (const path of ["/api/v1/me", "/api/v1/tasks", "/api/v1/integrations"]) {
    const res = await request.get(path);
    expect(res.status()).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthenticated");
    expect(body.data).toBeUndefined();
  }
});

test("cross-origin mutations are rejected even with a valid session (CSRF)", async ({
  browser,
}, testInfo) => {
  const page = await pageAs(browser, testInfo, ALICE_STATE);
  const res = await page.request.post("/api/v1/integrations/google/connect", {
    headers: { origin: "https://evil.example", "content-type": "application/json" },
    data: {},
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).error.code).toBe("csrf_rejected");
});

test("wrong demo password does not sign in", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Demo password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in as demo student" }).click();
  await expect(page.getByText(/Sign-in failed|Too many sign-in attempts/)).toBeVisible();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("signing out ends the session", async ({ page }) => {
  await signIn(page, ALICE);
  await signOut(page);
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in$/);
});
