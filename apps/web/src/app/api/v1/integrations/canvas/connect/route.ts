import { z } from "zod";
import { getProfile } from "@scholar/db";
import { RETURN_PATHS } from "@scholar/services";
import { apiRoute, jsonData, notFound, readJson } from "@/lib/api";
import { db } from "@/lib/db";
import { connectCanvas } from "@/lib/services";

export const dynamic = "force-dynamic";

const body = z.object({ returnTo: z.enum(RETURN_PATHS).default("/onboarding") }).strict();

/**
 * Mock mode: connects the labelled synthetic Canvas. Live mode with an institution-approved
 * developer key: returns the configured Canvas host's authorization URL. Otherwise 403
 * `capability_unavailable` — the student uses manual assignment details instead.
 */
export const POST = apiRoute(
  { mutation: true, rateLimit: { bucket: "connect", limit: 10, windowMs: 60_000 } },
  async ({ req, user, requestId }) => {
    const input = await readJson(req, body);
    const profile = await getProfile(db(), user.id);
    if (!profile) throw notFound();
    const result = await connectCanvas(user, profile.timezone, input.returnTo, requestId);
    return jsonData(result, requestId, result.kind === "connected" ? 201 : 200);
  },
);
