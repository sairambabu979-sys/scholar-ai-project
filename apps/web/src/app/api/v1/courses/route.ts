import { listOwnedCourses } from "@scholar/db";
import { apiRoute, jsonData } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

export const GET = apiRoute({}, async ({ user, requestId }) =>
  jsonData(await listOwnedCourses(db(), user.id), requestId),
);
