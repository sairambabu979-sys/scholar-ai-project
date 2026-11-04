import { getOwnedJob } from "@scholar/db";
import { apiRoute, jsonData, notFound, parseId } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = apiRoute<{ id: string }>({}, async ({ user, requestId }, params) => {
  const job = await getOwnedJob(db(), user.id, parseId(params.id));
  if (!job) throw notFound();
  return jsonData(job, requestId);
});
