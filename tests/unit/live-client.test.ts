import { describe, expect, it } from "vitest";
import {
  classifyGoogleApiError,
  LiveGoogleTasksClient,
  ProviderError,
} from "@scholar/integrations";

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const err = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function client(responses: Response[], opts: { onRefresh?: () => void } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let version = 1;
  const c = new LiveGoogleTasksClient({
    fetch: async (url, init) => {
      calls.push({ url, init });
      const r = responses.shift();
      if (!r) throw new Error("no more responses");
      return r;
    },
    tokens: {
      get: async () => ({ accessToken: `token-v${version}`, tokenVersion: version }),
      refreshAfterRejection: async () => {
        opts.onRefresh?.();
        version++;
        return { accessToken: `token-v${version}`, tokenVersion: version };
      },
    },
  });
  return { c, calls };
}

const opts = { showCompleted: true, showHidden: true, showDeleted: true };

describe("live Google Tasks client", () => {
  it("calls only the fixed Tasks host with a bearer token and no redirects", async () => {
    const { c, calls } = client([ok({ items: [] })]);
    await c.listTasks("abcDEF123", {
      ...opts,
      updatedMin: "2026-11-04T10:00:00.000Z",
      pageToken: "p2",
    });
    const u = new URL(calls[0]!.url);
    expect(u.origin).toBe("https://tasks.googleapis.com");
    expect(u.pathname).toBe("/tasks/v1/lists/abcDEF123/tasks");
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      showCompleted: "true",
      showHidden: "true",
      showDeleted: "true",
      updatedMin: "2026-11-04T10:00:00.000Z",
      pageToken: "p2",
      maxResults: "100",
    });
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe("Bearer token-v1");
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("refreshes once after a 401 and retries with the new token", async () => {
    let refreshed = 0;
    const { c, calls } = client([err(401, {}), ok({ items: [{ id: "l1", title: "L" }] })], {
      onRefresh: () => refreshed++,
    });
    const page = await c.listTaskLists();
    expect(page.items).toHaveLength(1);
    expect(refreshed).toBe(1);
    expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe("Bearer token-v2");
  });

  it("gives up with an auth error when the refreshed token is also rejected", async () => {
    let refreshed = 0;
    const { c } = client([err(401, {}), err(401, {})], { onRefresh: () => refreshed++ });
    await expect(c.listTaskLists()).rejects.toMatchObject({
      kind: "auth",
      code: "google_unauthorized",
    });
    expect(refreshed).toBe(1);
  });

  it("rejects list ids that could change the request path", async () => {
    const { c, calls } = client([]);
    for (const bad of ["../users", "a/b", "..", "x%2F"]) {
      await expect(c.listTasks(bad, opts)).rejects.toMatchObject({ code: "invalid_task_list_id" });
    }
    expect(calls).toHaveLength(0);
  });

  it("treats network failures as retryable", async () => {
    const c = new LiveGoogleTasksClient({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      tokens: {
        get: async () => ({ accessToken: "t", tokenVersion: 1 }),
        refreshAfterRejection: async () => ({ accessToken: "t", tokenVersion: 1 }),
      },
    });
    await expect(c.listTaskLists()).rejects.toMatchObject({
      kind: "retryable",
      code: "google_network_error",
    });
  });
});

describe("Google API error classification", () => {
  it("maps statuses and reasons to safe codes", () => {
    const c = (status: number, reason?: string, retryAfter: string | null = null) =>
      classifyGoogleApiError(
        status,
        reason ? { error: { errors: [{ reason }] } } : null,
        retryAfter,
      );
    expect(c(429, undefined, "30")).toMatchObject({
      kind: "retryable",
      code: "google_rate_limited",
      retryAfterMs: 30_000,
    });
    expect(c(503)).toMatchObject({ kind: "retryable", code: "google_http_503" });
    expect(c(403, "userRateLimitExceeded")).toMatchObject({ kind: "retryable" });
    expect(c(403, "accessNotConfigured")).toMatchObject({
      kind: "unavailable",
      code: "google_tasks_api_disabled",
    });
    expect(c(403, "insufficientPermissions")).toMatchObject({
      kind: "auth",
      code: "google_insufficient_scope",
    });
    expect(c(404)).toMatchObject({ kind: "not_found" });
    expect(c(400)).toBeInstanceOf(ProviderError);
  });
});
