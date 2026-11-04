import { getOwnedTask } from "@scholar/db";
import { apiRoute, jsonData, notFound, parseId } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = apiRoute<{ id: string }>({}, async ({ user, requestId }, params) => {
  const task = await getOwnedTask(db(), user.id, parseId(params.id));
  if (!task) throw notFound();
  return jsonData(task, requestId);
});
