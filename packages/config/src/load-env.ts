import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";

/**
 * Load `.env.local` then `.env` from the repository root. Values already present in the
 * process environment always win, so CI/hosting configuration cannot be overridden by a
 * stray local file.
 */
export function loadEnvFiles(rootDir: string): string[] {
  const loaded: string[] = [];
  for (const name of [".env.local", ".env"]) {
    const file = path.join(rootDir, name);
    if (existsSync(file)) {
      loadDotenv({ path: file, override: false, quiet: true });
      loaded.push(name);
    }
  }
  return loaded;
}
