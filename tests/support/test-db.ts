import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFiles } from "@scholar/config/load-env";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Resolve the disposable test database. Refuses anything whose database name does not end in
 * `_test`, so tests can never default to a development or production database.
 */
export function testDatabaseUrl(): string {
  loadEnvFiles(repoRoot);
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("TEST_DATABASE_URL is not set (see .env.example)");
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!name.endsWith("_test")) {
    throw new Error(`Refusing to use database "${name}" for tests: name must end in _test`);
  }
  return url;
}
