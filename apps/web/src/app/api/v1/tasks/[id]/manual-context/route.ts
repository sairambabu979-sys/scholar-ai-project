import { z } from "zod";
import { deleteManualContext, upsertManualContext } from "@scholar/db";
import { isValidDateOnly } from "@scholar/domain";
import { apiRoute, ApiError, jsonData, notFound, parseId, readJson } from "@/lib/api";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const httpsUrl = z
  .string()
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" && !u.username && !u.password;
    } catch {
      return false;
    }
  }, "Sources must be https links");

const body = z
  .object({
    title: z.string().trim().min(1).max(300),
    requirements: z.string().max(10_000).default(""),
    sources: z.array(httpsUrl).max(20).default([]),
    dueDate: z.string().refine(isValidDateOnly, "Expected YYYY-MM-DD").nullable().default(null),
    dueAt: z.iso.datetime({ offset: true }).nullable().default(null),
    /** Version being edited (null when creating); a concurrent change returns 409. */
    expectedVersion: z.number().int().positive().nullable(),
  })
  .strict()
  .refine((b) => !(b.dueDate && b.dueAt), "Give a due date or a due time, not both");

/**
 * Student-supplied assignment context (works without Canvas). Sources are stored as links to
 * display; the server never fetches them. No provider identity is fabricated.
 */
export const PUT = apiRoute<{ id: string }>(
  { mutation: true },
  async ({ req, user, requestId }, params) => {
    const taskId = parseId(params.id);
    const input = await readJson(req, body);
    const r = await upsertManualContext(
      db(),
      user.id,
      taskId,
      {
        title: input.title,
        requirements: input.requirements,
        sources: [...new Set(input.sources)],
        dueDate: input.dueDate,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
      },
      input.expectedVersion,
      requestId,
    );
    if (!r.ok) {
      if (r.reason === "not_found") throw notFound();
      throw new ApiError(
        "conflict",
        "These details changed in another window; reload and try again",
      );
    }
    return jsonData({ version: r.version }, requestId);
  },
);

export const DELETE = apiRoute<{ id: string }>(
  { mutation: true },
  async ({ user, requestId }, params) => {
    const removed = await deleteManualContext(db(), user.id, parseId(params.id), requestId);
    if (!removed) throw notFound();
    return jsonData({ deleted: true }, requestId);
  },
);
