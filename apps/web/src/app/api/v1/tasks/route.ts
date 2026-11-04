import { z } from "zod";
import { listTasksPage } from "@scholar/db";
import { isValidDateOnly } from "@scholar/domain";
import { apiRoute, ApiError, jsonData } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const dateOnly = z.string().refine(isValidDateOnly, "Expected YYYY-MM-DD");
const query = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.uuid().optional(),
    status: z.enum(["needs_action", "completed"]).optional(),
    dueFrom: dateOnly.optional(),
    dueTo: dateOnly.optional(),
    listId: z.uuid().optional(),
  })
  .strict();

export const GET = apiRoute({}, async ({ req, user, requestId }) => {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const q = query.safeParse(params);
  if (!q.success) throw new ApiError("invalid_request", "Invalid query parameters");
  const page = await listTasksPage(db(), user.id, q.data);
  return jsonData(page, requestId);
});
