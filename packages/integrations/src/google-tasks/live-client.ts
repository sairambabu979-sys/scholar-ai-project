/**
 * LIVE read-only Google Tasks client (REST v1). Talks only to the fixed Google Tasks host,
 * never follows redirects, and never puts credentials in errors or logs.
 * Reference: https://developers.google.com/workspace/tasks/reference/rest
 */
import { ProviderError } from "../errors.ts";
import { DEFAULT_TIMEOUT_MS, retryAfterMs, type FetchLike } from "../http.ts";
import type {
  GoogleTaskListPage,
  GoogleTaskPage,
  GoogleTasksReadClient,
  ListTasksOptions,
} from "./types.ts";

export const GOOGLE_TASKS_API_BASE = "https://tasks.googleapis.com/tasks/v1";
const MAX_PAGE_SIZE = 100;

export interface AccessTokenProvider {
  /** A currently valid access token plus the version it came from. */
  get(): Promise<{ accessToken: string; tokenVersion: number }>;
  /** Called after a 401: refresh unless another worker already did (version changed). */
  refreshAfterRejection(
    rejectedVersion: number,
  ): Promise<{ accessToken: string; tokenVersion: number }>;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    errors?: Array<{ reason?: string }>;
    details?: Array<{ reason?: string }>;
  };
}

function reasonsOf(body: GoogleErrorBody | null): Set<string> {
  const out = new Set<string>();
  const e = body?.error;
  if (e?.status) out.add(e.status);
  for (const r of e?.errors ?? []) if (r.reason) out.add(r.reason);
  for (const d of e?.details ?? []) if (d.reason) out.add(d.reason);
  return out;
}

/** Map a Google API failure to a provider error with a safe, stable code. */
export function classifyGoogleApiError(
  status: number,
  body: GoogleErrorBody | null,
  retryAfter: string | null,
): ProviderError {
  const reasons = reasonsOf(body);
  const retryMs = retryAfterMs(retryAfter);
  if (status === 429)
    return new ProviderError("retryable", "google_rate_limited", undefined, retryMs);
  if (status >= 500)
    return new ProviderError("retryable", `google_http_${status}`, undefined, retryMs);
  if (status === 401) return new ProviderError("auth", "google_unauthorized");
  if (status === 403) {
    if (
      [
        "rateLimitExceeded",
        "userRateLimitExceeded",
        "RESOURCE_EXHAUSTED",
        "RATE_LIMIT_EXCEEDED",
      ].some((r) => reasons.has(r))
    ) {
      return new ProviderError("retryable", "google_rate_limited", undefined, retryMs);
    }
    if (["accessNotConfigured", "SERVICE_DISABLED"].some((r) => reasons.has(r))) {
      return new ProviderError("unavailable", "google_tasks_api_disabled");
    }
    if (
      ["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"].some((r) => reasons.has(r))
    ) {
      return new ProviderError("auth", "google_insufficient_scope");
    }
    return new ProviderError("fatal", "google_forbidden");
  }
  if (status === 404) return new ProviderError("not_found", "google_not_found");
  if (status === 400) return new ProviderError("fatal", "google_bad_request");
  return new ProviderError("fatal", `google_http_${status}`);
}

export class LiveGoogleTasksClient implements GoogleTasksReadClient {
  readonly mode = "live" as const;

  constructor(
    private readonly deps: { fetch: FetchLike; tokens: AccessTokenProvider; timeoutMs?: number },
  ) {}

  private async request(
    path: string,
    params: Record<string, string | undefined>,
  ): Promise<unknown> {
    const url = new URL(`${GOOGLE_TASKS_API_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);

    let token = await this.deps.tokens.get();
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await this.deps.fetch(url.toString(), {
          method: "GET",
          headers: { authorization: `Bearer ${token.accessToken}`, accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        throw new ProviderError(
          "retryable",
          name === "TimeoutError" ? "google_timeout" : "google_network_error",
        );
      }
      if (res.status === 401 && attempt === 0) {
        // Refresh once (serialized across workers), then retry the same request.
        token = await this.deps.tokens.refreshAfterRejection(token.tokenVersion);
        continue;
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        if (res.ok) throw new ProviderError("fatal", "google_invalid_json");
      }
      if (!res.ok)
        throw classifyGoogleApiError(
          res.status,
          body as GoogleErrorBody,
          res.headers.get("retry-after"),
        );
      return body;
    }
    throw new ProviderError("auth", "google_unauthorized");
  }

  async listTaskLists(opts: { pageToken?: string } = {}): Promise<GoogleTaskListPage> {
    return (await this.request("/users/@me/lists", {
      maxResults: String(MAX_PAGE_SIZE),
      pageToken: opts.pageToken,
    })) as GoogleTaskListPage;
  }

  async listTasks(taskListId: string, opts: ListTasksOptions): Promise<GoogleTaskPage> {
    // Provider IDs are base64-like; reject anything that could alter the path (/, ., %).
    if (!/^[A-Za-z0-9_=:-]{1,256}$/.test(taskListId))
      throw new ProviderError("fatal", "invalid_task_list_id");
    return (await this.request(`/lists/${encodeURIComponent(taskListId)}/tasks`, {
      maxResults: String(Math.min(opts.maxResults ?? MAX_PAGE_SIZE, MAX_PAGE_SIZE)),
      pageToken: opts.pageToken,
      updatedMin: opts.updatedMin,
      showCompleted: String(opts.showCompleted),
      showHidden: String(opts.showHidden),
      showDeleted: String(opts.showDeleted),
    })) as GoogleTaskPage;
  }
}
