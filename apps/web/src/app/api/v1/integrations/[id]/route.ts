import { z } from "zod";
import { disconnectIntegration } from "@scholar/db";
import { apiRoute, jsonData, notFound, parseId, readJson } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const body = z.object({ deleteCachedData: z.boolean() }).strict();

/** Disable sync, cancel queued jobs, signal running ones, optionally delete cached data. */
export const DELETE = apiRoute<{ id: string }>(
  { mutation: true },
  async ({ req, user, requestId }, params) => {
    const id = parseId(params.id);
    const input = await readJson(req, body);
    const r = await disconnectIntegration(db(), user.id, id, {
      deleteCachedData: input.deleteCachedData,
      now: new Date(),
      requestId,
    });
    if (!r) throw notFound();
    return jsonData(r, requestId);
  },
);
