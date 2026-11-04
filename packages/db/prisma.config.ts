import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";
import { loadEnvFiles } from "@scholar/config/load-env";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnvFiles(path.resolve(here, "../.."));

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx src/seed-demo.ts",
  },
  // Optional so `prisma generate` works without a database; migrate commands fail loudly
  // when it is missing.
  datasource: { url: process.env.DATABASE_URL },
});
