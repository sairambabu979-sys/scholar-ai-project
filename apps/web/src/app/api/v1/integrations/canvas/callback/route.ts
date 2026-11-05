import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { completeCanvasConnection } from "@scholar/services";
import { serverEnv } from "@/lib/server-env";
import { getSessionUser } from "@/lib/session";
import { canvasConnectionDeps } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Canvas redirects here after authorization. Authorized by the single-use state bound to this
 * session, provider, app origin and redirect URI. Redirects only to fixed paths with an
 * enumerated status; nothing from the query string is reflected.
 */
export async function GET(req: Request) {
  const env = serverEnv();
  const requestId = randomUUID();
  const to = (path: string, params: Record<string, string>) => {
    const url = new URL(path, env.appUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return NextResponse.redirect(url, {
      status: 303,
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "x-request-id": requestId,
      },
    });
  };
  const user = await getSessionUser(req.headers);
  if (!user) return to("/sign-in", {});
  const deps = canvasConnectionDeps();
  if (!deps) return to("/onboarding", { canvas: "error", reason: "not_configured" });
  const q = new URL(req.url).searchParams;
  const result = await completeCanvasConnection(deps, {
    userId: user.id,
    sessionId: user.sessionId,
    state: q.get("state"),
    code: q.get("code"),
    error: q.get("error"),
    requestId,
  });
  return result.ok
    ? to(result.returnPath, { canvas: "connected" })
    : to(result.returnPath, { canvas: "error", reason: result.reason });
}
