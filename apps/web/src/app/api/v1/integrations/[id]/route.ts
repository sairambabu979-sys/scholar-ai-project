import { z } from "zod";
import { apiRoute, jsonData, notFound, parseId, readJson } from "@/lib/api";
import { disconnect } from "@/lib/services";

export const dynamic = "force-dynamic";

const body = z.object({ deleteCachedData: z.boolean() }).strict();

/**
 * Disable sync, cancel queued jobs, signal running ones, erase credentials, optionally delete
 * cached data; then attempt provider revocation and report the real outcome.
 */
export const DELETE = apiRoute<{ id: string }>(
  { mutation: true },
  async ({ req, user, requestId }, params) => {
    const id = parseId(params.id);
    const input = await readJson(req, body);
    const r = await disconnect(user.id, id, input.deleteCachedData, requestId);
    if (!r) throw notFound();
    return jsonData(r, requestId);
  },
);
