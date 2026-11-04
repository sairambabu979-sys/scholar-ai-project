import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { serverEnv } from "@/lib/server-env";

export const dynamic = "force-dynamic";

const WORKER_FRESH_MS = 60_000;

/** Liveness/readiness without any user data. */
export async function GET() {
  let database: "ok" | "error" = "error";
  let worker: { status: "ok" | "stale" | "absent"; lastHeartbeatAt: string | null } = {
    status: "absent",
    lastHeartbeatAt: null,
  };
  let mode: string | null = null;
  try {
    mode = serverEnv().integrationsMode;
    await db().$queryRaw`SELECT 1`;
    database = "ok";
    const hb = await db().workerHeartbeat.findFirst({ orderBy: { lastSeenAt: "desc" } });
    if (hb) {
      const fresh = Date.now() - hb.lastSeenAt.getTime() < WORKER_FRESH_MS;
      worker = { status: fresh ? "ok" : "stale", lastHeartbeatAt: hb.lastSeenAt.toISOString() };
    }
  } catch {
    database = "error";
  }
  const status = database === "ok" && worker.status === "ok" ? "ok" : "degraded";
  return NextResponse.json(
    { status, database, worker, integrationsMode: mode },
    { status: database === "ok" ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
