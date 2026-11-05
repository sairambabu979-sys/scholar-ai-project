import { z } from "zod";
import { listOwnedAssignmentsPage } from "@scholar/db";
import { apiRoute, ApiError, jsonData } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const query = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.uuid().optional(),
    courseId: z.uuid().optional(),
  })
  .strict();

export const GET = apiRoute({}, async ({ req, user, requestId }) => {
  const q = query.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) throw new ApiError("invalid_request", "Invalid query parameters");
  return jsonData(await listOwnedAssignmentsPage(db(), user.id, q.data), requestId);
});
