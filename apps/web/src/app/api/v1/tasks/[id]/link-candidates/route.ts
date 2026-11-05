import { getProfile } from "@scholar/db";
import { apiRoute, jsonData, notFound, parseId } from "@/lib/api";
import { db } from "@/lib/db";
import { linkCandidates } from "@/lib/services";

export const dynamic = "force-dynamic";

/** Ranked possible Canvas assignments with reasons. Never links anything implicitly. */
export const GET = apiRoute<{ id: string }>({}, async ({ user, requestId }, params) => {
  const profile = await getProfile(db(), user.id);
  const r = await linkCandidates(user.id, parseId(params.id), profile?.timezone ?? "UTC");
  if (!r) throw notFound();
  return jsonData(r, requestId);
});
