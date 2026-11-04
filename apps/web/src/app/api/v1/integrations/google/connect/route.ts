import { getProfile } from "@scholar/db";
import { apiRoute, jsonData, notFound } from "@/lib/api";
import { db } from "@/lib/db";
import { connectGoogleTasks } from "@/lib/services";

export const dynamic = "force-dynamic";

/**
 * Mock mode: connects the labelled fixture adapter. Live mode: returns
 * `capability_unavailable` until the Phase 2 OAuth flow exists (no silent fallback).
 */
export const POST = apiRoute(
  { mutation: true, rateLimit: { bucket: "connect", limit: 10, windowMs: 60_000 } },
  async ({ user, requestId }) => {
    const profile = await getProfile(db(), user.id);
    if (!profile) throw notFound();
    const result = await connectGoogleTasks(user.id, profile.timezone, requestId);
    return jsonData(result, requestId, 201);
  },
);
