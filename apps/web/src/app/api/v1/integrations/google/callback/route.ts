import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { completeGoogleTasksConnection } from "@scholar/services";
import { serverEnv } from "@/lib/server-env";
import { getSessionUser } from "@/lib/session";
import { googleConnectionDeps } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Google redirects here after consent. The request is authorized by the single-use OAuth
 * state (bound to this user's session, provider and app origin), not by the URL alone. The
 * response only ever redirects to a fixed, allowlisted path with an enumerated status code;
 * nothing from the query string is reflected.
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
  const deps = googleConnectionDeps();
  if (!deps) return to("/onboarding", { google: "error", reason: "not_configured" });

  const q = new URL(req.url).searchParams;
  const result = await completeGoogleTasksConnection(deps, {
    userId: user.id,
    sessionId: user.sessionId,
    state: q.get("state"),
    code: q.get("code"),
    error: q.get("error"),
    requestId,
  });
  return result.ok
    ? to(result.returnPath, { google: "connected" })
    : to(result.returnPath, { google: "error", reason: result.reason });
}
