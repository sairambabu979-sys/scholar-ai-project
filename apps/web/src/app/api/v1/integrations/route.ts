import { listIntegrations, listOwnedTaskLists } from "@scholar/db";
import { apiRoute, jsonData } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = apiRoute({}, async ({ user, requestId }) => {
  const [integrations, lists] = await Promise.all([
    listIntegrations(db(), user.id),
    listOwnedTaskLists(db(), user.id),
  ]);
  return jsonData(
    integrations.map((i) => ({
      ...i,
      taskLists: lists.filter((l) => l.integrationId === i.id),
    })),
    requestId,
  );
});
