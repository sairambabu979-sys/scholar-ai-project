import "server-only";
import { getSharedPrismaClient, type Db } from "@scholar/db";
import { serverEnv } from "./server-env";

export function db(): Db {
  return getSharedPrismaClient(serverEnv().databaseUrl);
}
