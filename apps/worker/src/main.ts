import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadEnvFiles } from "@scholar/config/load-env";
import { ConfigError, getEnv } from "@scholar/config";
import { createPrismaClient } from "@scholar/db";
import { canvasOAuthFromEnv, googleTasksOAuthFromEnv, keyringFromEnv } from "@scholar/services";
import { createGuardedFetch } from "@scholar/security";
import { systemClock } from "@scholar/domain";
import { createLogger } from "@scholar/security";
import { createCanvasClientFactory, createGoogleTasksClientFactory } from "./client-factory.ts";
import { recoverLeases, runOnce } from "./runner.ts";
import { scheduleDueSyncs } from "./scheduler.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnvFiles(path.resolve(here, "../../.."));

const logger = createLogger({ service: "worker" });

let env;
try {
  env = getEnv();
} catch (e) {
  if (e instanceof ConfigError) {
    logger.error("config.invalid", { issues: e.issues });
    process.exit(1);
  }
  throw e;
}

const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
const db = createPrismaClient(env.databaseUrl);
const clock = systemClock;
const keyring = keyringFromEnv(env);
const oauth = googleTasksOAuthFromEnv(env);
const clientFor = createGoogleTasksClientFactory({
  integrationsMode: env.integrationsMode,
  clock,
  live:
    env.integrationsMode === "live" && keyring && oauth
      ? { db, keyring, fetch: (url, init) => fetch(url, init), oauth }
      : undefined,
});
const canvasOAuth = canvasOAuthFromEnv(env);
const canvasClientFor = createCanvasClientFactory({
  integrationsMode: env.integrationsMode,
  clock,
  live:
    canvasOAuth && keyring
      ? {
          db,
          keyring,
          oauth: canvasOAuth,
          fetch: createGuardedFetch({ allowedOrigins: [canvasOAuth.origin] }),
        }
      : undefined,
});
const startedAt = clock.now();

let stopping = false;
const timers: NodeJS.Timeout[] = [];

async function heartbeat() {
  await db.workerHeartbeat.upsert({
    where: { workerId },
    create: { workerId, startedAt, lastSeenAt: clock.now(), version: "0.1.0" },
    update: { lastSeenAt: clock.now() },
  });
}

async function loop() {
  let idleMs = 500;
  while (!stopping) {
    try {
      const outcome = await runOnce({ db, clock, logger, workerId, clientFor, canvasClientFor });
      if (outcome === "idle") {
        await new Promise((r) => setTimeout(r, idleMs));
        idleMs = Math.min(idleMs * 2, 5_000);
      } else {
        idleMs = 500;
      }
    } catch (e) {
      logger.error("runner.error", { error: e });
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

function every(ms: number, fn: () => Promise<unknown>, name: string) {
  const run = () => fn().catch((error) => logger.error(`${name}.error`, { error }));
  void run();
  timers.push(setInterval(run, ms));
}

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info("worker.stopping", { signal });
  for (const t of timers) clearInterval(t);
  // Give an in-flight job a moment to finish; its lease covers an abrupt exit.
  await new Promise((r) => setTimeout(r, 1_000));
  await db.workerHeartbeat.delete({ where: { workerId } }).catch(() => undefined);
  await db.$disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

logger.info("worker.started", {
  workerId,
  integrationsMode: env.integrationsMode,
  syncIntervalSeconds: env.syncIntervalSeconds,
});
if (env.integrationsMode === "mock") {
  logger.warn("worker.mock_mode", {
    note: "MOCK MODE: synthetic fixtures only; no provider calls",
  });
}

every(10_000, heartbeat, "heartbeat");
every(30_000, () => recoverLeases({ db, clock, logger }), "lease_recovery");
// Expired OAuth transactions are useless and hold sealed PKCE verifiers; drop them.
every(
  10 * 60_000,
  () =>
    db.oAuthState.deleteMany({
      where: { expiresAt: { lt: new Date(clock.now().getTime() - 60 * 60_000) } },
    }),
  "oauth_state_cleanup",
);
every(
  60_000,
  () => scheduleDueSyncs({ db, clock, logger, intervalSeconds: env.syncIntervalSeconds }),
  "scheduler",
);
void loop();
