import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";

export type Db = PrismaClient;

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString: databaseUrl, max: 10 });
  return new PrismaClient({ adapter });
}

const globalForPrisma = globalThis as unknown as { __scholarPrisma?: PrismaClient };

/** Process-wide client (survives Next.js dev hot reloads). */
export function getSharedPrismaClient(databaseUrl: string): PrismaClient {
  if (!globalForPrisma.__scholarPrisma) {
    globalForPrisma.__scholarPrisma = createPrismaClient(databaseUrl);
  }
  return globalForPrisma.__scholarPrisma;
}
