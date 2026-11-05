/**
 * LIVE read-only Canvas client for one approved origin. Every request URL — including `Link`
 * pagination URLs supplied by the server — must stay on that origin; redirects are refused; the
 * bearer token is sent nowhere else. Never uses `include[]=read_status` (it marks items read).
 */
import { ProviderError } from "../errors.ts";
import { DEFAULT_TIMEOUT_MS, retryAfterMs, type FetchLike } from "../http.ts";
import type { AccessTokenProvider } from "../google-tasks/live-client.ts";
import type { CanvasReadClient, Page } from "./types.ts";

const PER_PAGE = "50";

/** Parse an RFC 8288 Link header and return the rel="next" target, if any. */
export function parseNextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const m = /<([^>]+)>\s*;(.*)/.exec(part.trim());
    if (m && /rel="?next"?/i.test(m[2]!)) return m[1];
  }
  return undefined;
}

function classify(status: number, bodyText: string, headers: Headers): ProviderError {
  const retry = retryAfterMs(headers.get("retry-after"));
  if (status === 429 || (status === 403 && /rate limit exceeded/i.test(bodyText))) {
    return new ProviderError("retryable", "canvas_throttled", undefined, retry ?? 30_000);
  }
  if (status >= 500)
    return new ProviderError("retryable", `canvas_http_${status}`, undefined, retry);
  if (status === 401) return new ProviderError("auth", "canvas_unauthorized");
  if (status === 403)
    return new ProviderError("unavailable", "canvas_forbidden_scope_or_permission");
  if (status === 404) return new ProviderError("not_found", "canvas_not_found");
  return new ProviderError("fatal", `canvas_http_${status}`);
}

export class LiveCanvasClient implements CanvasReadClient {
  readonly mode = "live" as const;

  constructor(
    private readonly deps: {
      origin: string;
      fetch: FetchLike;
      tokens: AccessTokenProvider;
      timeoutMs?: number;
    },
  ) {}

  private checkUrl(url: string): string {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ProviderError("fatal", "canvas_invalid_url");
    }
    if (u.origin !== this.deps.origin || u.protocol !== "https:" || u.username || u.password) {
      // A pagination link (or anything else) pointing elsewhere is never followed with a token.
      throw new ProviderError("fatal", "canvas_foreign_url_refused");
    }
    if (u.searchParams.getAll("include[]").includes("read_status"))
      throw new ProviderError("fatal", "canvas_read_status_refused");
    return u.toString();
  }

  private async get(url: string): Promise<Page<unknown>> {
    const target = this.checkUrl(url);
    let token = await this.deps.tokens.get();
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await this.deps.fetch(target, {
          method: "GET",
          headers: { authorization: `Bearer ${token.accessToken}`, accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (e) {
        const name = (e as { name?: string })?.name;
        if (name === "UrlPolicyError") throw new ProviderError("fatal", "canvas_url_policy");
        throw new ProviderError(
          "retryable",
          name === "TimeoutError" ? "canvas_timeout" : "canvas_network_error",
        );
      }
      if (res.status === 401 && attempt === 0) {
        token = await this.deps.tokens.refreshAfterRejection(token.tokenVersion);
        continue;
      }
      if (!res.ok) throw classify(res.status, await res.text().catch(() => ""), res.headers);
      let items: unknown;
      try {
        items = await res.json();
      } catch {
        throw new ProviderError("fatal", "canvas_invalid_json");
      }
      if (!Array.isArray(items)) throw new ProviderError("fatal", "canvas_unexpected_shape");
      const next = parseNextLink(res.headers.get("link"));
      return { items, next: next ? this.checkUrl(next) : undefined };
    }
    throw new ProviderError("auth", "canvas_unauthorized");
  }

  async listCourses(next?: string): Promise<Page<unknown>> {
    if (next) return this.get(next);
    const url = new URL("/api/v1/courses", this.deps.origin);
    url.searchParams.set("enrollment_type", "student");
    url.searchParams.set("enrollment_state", "active");
    url.searchParams.set("per_page", PER_PAGE);
    return this.get(url.toString());
  }

  async listAssignments(courseExternalId: string, next?: string): Promise<Page<unknown>> {
    if (next) return this.get(next);
    if (!/^\d{1,20}$/.test(courseExternalId))
      throw new ProviderError("fatal", "canvas_invalid_course_id");
    const url = new URL(`/api/v1/courses/${courseExternalId}/assignments`, this.deps.origin);
    url.searchParams.set("per_page", PER_PAGE);
    url.searchParams.set("order_by", "due_at");
    // Own submission only; may be ignored by a scoped key (then status is "unavailable").
    url.searchParams.append("include[]", "submission");
    return this.get(url.toString());
  }
}
