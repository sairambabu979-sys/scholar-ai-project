import { defineConfig, devices } from "@playwright/test";
import { testDatabaseUrl } from "./tests/support/test-db.ts";

/**
 * Browser journey tests. They run the real web app (Next dev server, mock mode) and the real
 * worker against the disposable `_test` database, with synthetic fixtures only. No provider is
 * contacted and nothing is written outside the test database.
 */
const PORT = 3100;
const APP_URL = `http://localhost:${PORT}`;
const DATABASE_URL = testDatabaseUrl();

const serverEnv = {
  NODE_ENV: "development",
  APP_URL,
  DATABASE_URL,
  INTEGRATIONS_MODE: "mock",
  EXTERNAL_WRITES_ENABLED: "false",
  AUTH_SECRET: "e2e-only-secret-not-for-real-use-0123456789",
  DEMO_PASSWORD: "e2e-demo-password",
  GOOGLE_AUTH_REDIRECT_URI: `${APP_URL}/api/auth/callback/google`,
  GOOGLE_TASKS_REDIRECT_URI: `${APP_URL}/api/v1/integrations/google/callback`,
  CANVAS_REDIRECT_URI: `${APP_URL}/api/v1/integrations/canvas/callback`,
  LOG_LEVEL: "warn",
};

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: APP_URL,
    trace: "retain-on-failure",
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
      : {}),
  },
  projects: [
    { name: "setup", testMatch: /global\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testIgnore: /responsive\.spec\.ts/,
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      dependencies: ["chromium"],
      testMatch: /responsive\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: `npx next dev --port ${PORT}`,
      cwd: "apps/web",
      url: `${APP_URL}/api/health`,
      env: serverEnv,
      timeout: 180_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
    },
    {
      command: "npx tsx apps/worker/src/main.ts",
      env: { ...serverEnv, LOG_LEVEL: "info" },
      wait: { stdout: /worker\.started/ },
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "pipe",
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
