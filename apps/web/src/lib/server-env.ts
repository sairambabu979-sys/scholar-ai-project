import "server-only";
import { getEnv, type AppEnv } from "@scholar/config";

export function serverEnv(): AppEnv {
  return getEnv();
}
