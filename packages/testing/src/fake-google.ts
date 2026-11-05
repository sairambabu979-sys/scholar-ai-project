/**
 * FAKE Google endpoints for tests (OAuth token + revocation + Tasks REST), exposed as an
 * injectable `fetch`. Never contacts Google. Access tokens expire and are checked, so tests can
 * exercise refresh, 401 handling and revocation through the production code paths.
 */
import { URL } from "node:url";
import type { Clock } from "@scholar/domain";
import {
  GOOGLE_REVOCATION_ENDPOINT,
  GOOGLE_TASKS_API_BASE,
  GOOGLE_TOKEN_ENDPOINT,
  TASKS_READONLY_SCOPE,
} from "@scholar/integrations";
import type { MockGoogleTasksClient } from "./mock-google-tasks-client.ts";

export interface FakeGoogleOptions {
  clock: Clock;
  clientId: string;
  clientSecret: string;
  tasks: MockGoogleTasksClient;
  /** Google account subject returned in the ID token. */
  sub?: string;
  accessTokenTtlSeconds?: number;
}

export interface FakeCall {
  url: string;
  method: string;
  redirect?: RequestInit["redirect"];
  authorization?: string | null;
  form?: Record<string, string>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export class FakeGoogle {
  readonly calls: FakeCall[] = [];
  /** Codes the fake authorization server has "issued" (code -> expected PKCE verifier/scopes). */
  private codes = new Map<string, { verifier: string; scopes: string[] }>();
  private accessTokens = new Map<string, number>(); // token -> expiry ms
  private refreshTokens = new Set<string>();
  revokedTokens: string[] = [];
  private counter = 0;

  // Behaviour switches for tests.
  omitRefreshTokenOnExchange = false;
  rotateRefreshTokenOnRefresh = false;
  grantedScopes: string[] = ["openid", TASKS_READONLY_SCOPE];
  refreshFailure: null | "invalid_grant" | "server_error" = null;
  revocationStatus = 200;
  refreshDelayMs = 0;

  constructor(private readonly opts: FakeGoogleOptions) {}

  get refreshCalls(): number {
    return this.calls.filter(
      (c) => c.url === GOOGLE_TOKEN_ENDPOINT && c.form?.grant_type === "refresh_token",
    ).length;
  }

  /** Simulate the user approving consent: returns an authorization code for the callback. */
  approve(input: { codeChallenge: string; codeVerifier: string; scopes?: string[] }): string {
    const code = `fake-code-${++this.counter}`;
    this.codes.set(code, {
      verifier: input.codeVerifier,
      scopes: input.scopes ?? this.grantedScopes,
    });
    return code;
  }

  /** Expire every issued access token (forces refresh or 401). */
  expireAccessTokens(): void {
    for (const k of this.accessTokens.keys()) this.accessTokens.set(k, 0);
  }

  private issueAccess(): { token: string; expiresIn: number } {
    const ttl = this.opts.accessTokenTtlSeconds ?? 3600;
    const token = `fake-access-${++this.counter}`;
    this.accessTokens.set(token, this.opts.clock.now().getTime() + ttl * 1000);
    return { token, expiresIn: ttl };
  }

  private idToken(): string {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const now = Math.floor(this.opts.clock.now().getTime() / 1000);
    return `${enc({ alg: "none", typ: "JWT" })}.${enc({
      iss: "https://accounts.google.com",
      aud: this.opts.clientId,
      sub: this.opts.sub ?? "fake-google-sub-1",
      email: "student@scholar.example",
      email_verified: true,
      iat: now,
      exp: now + 3600,
    })}.fake-signature`;
  }

  readonly fetch = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers = new Headers(init.headers);
    const form =
      typeof init.body === "string"
        ? Object.fromEntries(new URLSearchParams(init.body))
        : undefined;
    this.calls.push({
      url: `${url.origin}${url.pathname}`,
      method: init.method ?? "GET",
      redirect: init.redirect,
      authorization: headers.get("authorization"),
      form,
    });

    if (`${url.origin}${url.pathname}` === GOOGLE_TOKEN_ENDPOINT) return this.token(form ?? {});
    if (`${url.origin}${url.pathname}` === GOOGLE_REVOCATION_ENDPOINT) {
      if (form?.token) this.revokedTokens.push(form.token);
      if (form?.token) {
        this.refreshTokens.delete(form.token);
        this.accessTokens.delete(form.token);
      }
      return new Response(null, { status: this.revocationStatus });
    }
    if (input.startsWith(GOOGLE_TASKS_API_BASE))
      return this.tasksApi(url, headers.get("authorization"));
    throw new Error(`FakeGoogle: unexpected host ${url.host}`);
  };

  private async token(form: Record<string, string>): Promise<Response> {
    if (form.client_id !== this.opts.clientId || form.client_secret !== this.opts.clientSecret) {
      return json(401, { error: "invalid_client" });
    }
    if (form.grant_type === "authorization_code") {
      const issued = this.codes.get(form.code ?? "");
      this.codes.delete(form.code ?? "");
      if (!issued || issued.verifier !== form.code_verifier)
        return json(400, { error: "invalid_grant" });
      const access = this.issueAccess();
      const refresh = `fake-refresh-${++this.counter}`;
      this.refreshTokens.add(refresh);
      return json(200, {
        access_token: access.token,
        expires_in: access.expiresIn,
        token_type: "Bearer",
        scope: issued.scopes.join(" "),
        id_token: issued.scopes.includes("openid") ? this.idToken() : undefined,
        ...(this.omitRefreshTokenOnExchange ? {} : { refresh_token: refresh }),
      });
    }
    if (form.grant_type === "refresh_token") {
      if (this.refreshDelayMs) await new Promise((r) => setTimeout(r, this.refreshDelayMs));
      if (this.refreshFailure === "server_error") return json(503, { error: "backend_error" });
      if (
        this.refreshFailure === "invalid_grant" ||
        !this.refreshTokens.has(form.refresh_token ?? "")
      ) {
        return json(400, {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        });
      }
      const access = this.issueAccess();
      let rotated: string | undefined;
      if (this.rotateRefreshTokenOnRefresh) {
        this.refreshTokens.delete(form.refresh_token!);
        rotated = `fake-refresh-${++this.counter}`;
        this.refreshTokens.add(rotated);
      }
      return json(200, {
        access_token: access.token,
        expires_in: access.expiresIn,
        token_type: "Bearer",
        scope: this.grantedScopes.join(" "),
        ...(rotated ? { refresh_token: rotated } : {}),
      });
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  private async tasksApi(url: URL, authorization: string | null): Promise<Response> {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    const exp = this.accessTokens.get(token);
    if (!exp || exp <= this.opts.clock.now().getTime()) {
      return json(401, {
        error: { code: 401, status: "UNAUTHENTICATED", message: "Invalid Credentials" },
      });
    }
    const path = url.pathname.replace(new URL(GOOGLE_TASKS_API_BASE).pathname, "");
    const q = url.searchParams;
    try {
      if (path === "/users/@me/lists") {
        return json(
          200,
          await this.opts.tasks.listTaskLists({ pageToken: q.get("pageToken") ?? undefined }),
        );
      }
      const m = /^\/lists\/([^/]+)\/tasks$/.exec(path);
      if (m) {
        return json(
          200,
          await this.opts.tasks.listTasks(decodeURIComponent(m[1]!), {
            pageToken: q.get("pageToken") ?? undefined,
            updatedMin: q.get("updatedMin") ?? undefined,
            showCompleted: q.get("showCompleted") !== "false",
            showHidden: q.get("showHidden") === "true",
            showDeleted: q.get("showDeleted") === "true",
            maxResults: q.get("maxResults") ? Number(q.get("maxResults")) : undefined,
          }),
        );
      }
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "task_list_not_found")
        return json(404, { error: { code: 404, status: "NOT_FOUND" } });
      if (code === "http_503") return json(503, { error: { code: 503, status: "UNAVAILABLE" } });
      throw e;
    }
    return json(404, { error: { code: 404, status: "NOT_FOUND" } });
  }
}
