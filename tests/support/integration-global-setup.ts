import { execFileSync } from "node:child_process";
import path from "node:path";
import { repoRoot, testDatabaseUrl } from "./test-db.ts";

/** Apply migrations to the disposable test database once per run. */
export default function setup() {
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
}
