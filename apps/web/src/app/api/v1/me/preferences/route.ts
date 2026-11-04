import { z } from "zod";
import { setSelectedLists, updatePreferences } from "@scholar/db";
import { isValidTimeZone } from "@scholar/domain";
import { apiRoute, ApiError, jsonData, notFound, readJson } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const body = z
  .object({
    timezone: z.string().max(64).refine(isValidTimeZone, "Unknown IANA timezone").optional(),
    syncEnabled: z.boolean().optional(),
    onboardingCompleted: z.literal(true).optional(),
    selectedLists: z
      .object({ integrationId: z.uuid(), listIds: z.array(z.uuid()).max(100) })
      .optional(),
  })
  .strict();

export const PATCH = apiRoute({ mutation: true }, async ({ req, user, requestId }) => {
  const input = await readJson(req, body);
  if (input.selectedLists) {
    const r = await setSelectedLists(
      db(),
      user.id,
      input.selectedLists.integrationId,
      [...new Set(input.selectedLists.listIds)],
      requestId,
    );
    if (!r.ok) {
      if (r.reason === "not_found") throw notFound();
      throw new ApiError("invalid_request", "Unknown task list");
    }
  }
  const { selectedLists: _ignored, ...prefs } = input;
  if (Object.keys(prefs).length > 0) await updatePreferences(db(), user.id, prefs, requestId);
  return jsonData({ updated: Object.keys(input) }, requestId);
});
