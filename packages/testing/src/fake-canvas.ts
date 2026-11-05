/**
 * FAKE Canvas HTTP endpoints for tests (OAuth token/revoke + courses/assignments with RFC 8288
 * Link pagination), exposed as an injectable `fetch`. Never contacts Canvas. Switches simulate
 * hostile or restricted servers: foreign pagination links, redirects, ignored includes,
 * throttling.
 */
import type { Clock } from "@scholar/domain";
import type { MockCanvasDataset } from "./canvas-fixtures.ts";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export class FakeCanvas {
  readonly calls: Array<{
    url: string;
    method: string;
    authorization: string | null;
    redirect?: RequestInit["redirect"];
  }> = [];
  private codes = new Map<string, string>(); // code -> verifier
  private access = new Map<string, number>();
  private refresh = new Set<string>();
  revoked: string[] = [];
  private n = 0;

  foreignNextLink = false;
  redirectApi = false;
  ignoreSubmissionInclude = false;
  throttleOnce = false;
  pageSize = 2;

  constructor(
    private readonly opts: {
      origin: string;
      clientId: string;
      clientSecret: string;
      clock: Clock;
      data: MockCanvasDataset;
      canvasUserId?: string;
    },
  ) {}

  approve(codeVerifier: string): string {
    const code = `canvas-code-${++this.n}`;
    this.codes.set(code, codeVerifier);
    return code;
  }

  expireAccessTokens() {
    for (const k of this.access.keys()) this.access.set(k, 0);
  }

  private issue() {
    const t = `canvas-access-${++this.n}`;
    this.access.set(t, this.opts.clock.now().getTime() + 3600_000);
    return t;
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    this.calls.push({
      url: url.toString(),
      method: init.method ?? "GET",
      authorization: headers.get("authorization"),
      redirect: init.redirect,
    });
    if (url.origin !== this.opts.origin) throw new Error(`FakeCanvas: unexpected host ${url.host}`);

    if (url.pathname === "/login/oauth2/token" && init.method === "POST") {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      if (form.client_id !== this.opts.clientId || form.client_secret !== this.opts.clientSecret)
        return json(401, { error: "invalid_client" });
      if (form.grant_type === "authorization_code") {
        const verifier = this.codes.get(form.code ?? "");
        this.codes.delete(form.code ?? "");
        if (verifier === undefined || verifier !== form.code_verifier)
          return json(400, { error: "invalid_grant" });
        const r = `canvas-refresh-${++this.n}`;
        this.refresh.add(r);
        return json(200, {
          access_token: this.issue(),
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: r,
          user: { id: Number(this.opts.canvasUserId ?? 4242), name: "Synthetic Student" },
        });
      }
      if (form.grant_type === "refresh_token") {
        if (!this.refresh.has(form.refresh_token ?? ""))
          return json(400, { error: "invalid_grant" });
        return json(200, { access_token: this.issue(), token_type: "Bearer", expires_in: 3600 });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/login/oauth2/token" && init.method === "DELETE") {
      const t = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      this.revoked.push(t);
      this.access.delete(t);
      return json(200, {});
    }

    const token = headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const exp = this.access.get(token);
    if (!exp || exp <= this.opts.clock.now().getTime())
      return json(401, { errors: [{ message: "Invalid access token." }] });
    if (this.redirectApi)
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      });
    if (this.throttleOnce) {
      this.throttleOnce = false;
      return new Response("403 Forbidden (Rate Limit Exceeded)", { status: 403 });
    }

    const page = Number(url.searchParams.get("page") ?? "1");
    const paginate = (items: unknown[]) => {
      const start = (page - 1) * this.pageSize;
      const slice = items.slice(start, start + this.pageSize);
      const headersOut: Record<string, string> = {};
      if (start + this.pageSize < items.length) {
        const next = new URL(url.toString());
        next.searchParams.set("page", String(page + 1));
        const target = this.foreignNextLink
          ? `https://evil.example${next.pathname}${next.search}`
          : next.toString();
        headersOut.link = `<${target}>; rel="next", <${url.toString()}>; rel="current"`;
      }
      return json(200, slice, headersOut);
    };
    if (url.pathname === "/api/v1/courses") return paginate(this.opts.data.courses);
    const m = /^\/api\/v1\/courses\/(\d+)\/assignments$/.exec(url.pathname);
    if (m) {
      const list = this.opts.data.assignments[m[1]!];
      if (!list)
        return json(404, { errors: [{ message: "The specified resource does not exist." }] });
      const includeSubmission =
        url.searchParams.getAll("include[]").includes("submission") &&
        !this.ignoreSubmissionInclude;
      return paginate(list.map((a) => (includeSubmission ? a : { ...a, submission: undefined })));
    }
    return json(404, { errors: [{ message: "not found" }] });
  };
}
