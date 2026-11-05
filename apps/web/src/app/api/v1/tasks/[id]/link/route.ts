import { z } from "zod";
import { confirmTaskLink, removeTaskLink } from "@scholar/db";
import { apiRoute, ApiError, jsonData, notFound, parseId, readJson } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const body = z
  .object({
    assignmentId: z.uuid(),
    method: z.enum(["url", "suggested", "manual"]),
    confidence: z.number().min(0).max(1).nullable().default(null),
    reasons: z.array(z.string().max(200)).max(5).default([]),
    /** The task version the student reviewed; a changed task returns 409. */
    expectedTaskVersion: z.string().min(1).max(128),
  })
  .strict();

/** Confirm a specific owned assignment for this task (the only way a link is created). */
export const PUT = apiRoute<{ id: string }>(
  { mutation: true },
  async ({ req, user, requestId }, params) => {
    const taskId = parseId(params.id);
    const input = await readJson(req, body);
    const r = await confirmTaskLink(db(), user.id, { taskId, ...input, requestId });
    if (!r.ok) {
      if (r.reason === "not_found") throw notFound();
      if (r.reason === "stale")
        throw new ApiError("conflict", "The task changed since you reviewed it; review again");
      throw new ApiError("invalid_request", "That assignment is no longer available in Canvas");
    }
    return jsonData({ linked: true }, requestId);
  },
);

export const DELETE = apiRoute<{ id: string }>(
  { mutation: true },
  async ({ user, requestId }, params) => {
    const taskId = parseId(params.id);
    const removed = await removeTaskLink(db(), user.id, taskId, requestId);
    if (!removed) throw notFound();
    return jsonData({ linked: false }, requestId);
  },
);
