import { apiRoute, jsonData, parseId } from "@/lib/api";
import { requestSync } from "@/lib/services";

export const dynamic = "force-dynamic";

export const POST = apiRoute<{ id: string }>(
  { mutation: true, rateLimit: { bucket: "sync", limit: 10, windowMs: 60_000 } },
  async ({ user, requestId }, params) => {
    const id = parseId(params.id);
    const job = await requestSync(user.id, id, "manual", requestId);
    return jsonData({ jobId: job.id, deduplicated: job.deduplicated }, requestId, 202);
  },
);
