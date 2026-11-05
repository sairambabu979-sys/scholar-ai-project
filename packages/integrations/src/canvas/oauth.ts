/**
 * Canvas OAuth2 for one configured, institution-approved origin. Endpoints are derived only
 * from that origin (never from user input or provider responses). Multi-user deployments must
 * use OAuth; personal access tokens are not accepted.
 * Reference: Canvas "OAuth2 Endpoints" (developerdocs.instructure.com).
 */
import { z } from "zod";
import { ProviderError } from "../errors.ts";
import { DEFAULT_TIMEOUT_MS, retryAfterMs, type FetchLike } from "../http.ts";
import type { TokenSet } from "../google-oauth/oauth.ts";

/** Default read-only scopes; must match the scopes enabled on the institution's developer key. */
export const CANVAS_DEFAULT_SCOPES = [
  "url:GET|/api/v1/courses",
  "url:GET|/api/v1/courses/:course_id/assignments",
] as const;

export interface CanvasOAuthConfig {
  origin: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: readonly string[];
}

export function buildCanvasAuthorizationUrl(input: {
  config: CanvasOAuthConfig;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL("/login/oauth2/auth", input.config.origin);
  const p = url.searchParams;
  p.set("client_id", input.config.clientId);
  p.set("response_type", "code");
  p.set("redirect_uri", input.config.redirectUri);
  p.set("state", input.state);
  if (input.config.scopes.length > 0) p.set("scope", input.config.scopes.join(" "));
  // PKCE: sent for defence in depth; harmless where an instance does not enforce it.
  p.set("code_challenge", input.codeChallenge);
  p.set("code_challenge_method", "S256");
  return url.toString();
}

const canvasTokenSchema = z.object({
  access_token: z.string().min(1).max(4096),
  token_type: z.string(),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(86_400 * 30)
    .optional(),
  refresh_token: z.string().min(1).max(4096).optional(),
  user: z.object({ id: z.union([z.number(), z.string()]).transform(String) }).optional(),
});

export interface CanvasTokenSet extends TokenSet {
  canvasUserId?: string;
}

async function tokenRequest(
  fetchImpl: FetchLike,
  origin: string,
  form: Record<string, string>,
  now: Date,
): Promise<CanvasTokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(new URL("/login/oauth2/token", origin).toString(), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    if ((e as { name?: string })?.name === "UrlPolicyError")
      throw new ProviderError("fatal", "canvas_url_policy");
    throw new ProviderError("retryable", "canvas_oauth_network_error");
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError(
      res.status >= 500 ? "retryable" : "fatal",
      `canvas_oauth_http_${res.status}`,
    );
  }
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) {
      throw new ProviderError(
        "retryable",
        `canvas_oauth_http_${res.status}`,
        undefined,
        retryAfterMs(res.headers.get("retry-after")),
      );
    }
    const error = (body as { error?: unknown })?.error;
    if (error === "invalid_grant") throw new ProviderError("auth", "invalid_grant");
    if (error === "invalid_client" || error === "unauthorized_client")
      throw new ProviderError("fatal", "canvas_oauth_client_misconfigured");
    throw new ProviderError("fatal", `canvas_oauth_http_${res.status}`);
  }
  const t = canvasTokenSchema.safeParse(body);
  if (!t.success || t.data.token_type.toLowerCase() !== "bearer")
    throw new ProviderError("fatal", "canvas_oauth_invalid_token_response");
  return {
    accessToken: t.data.access_token,
    accessTokenExpiresAt: t.data.expires_in
      ? new Date(now.getTime() + t.data.expires_in * 1000)
      : null,
    refreshToken: t.data.refresh_token,
    scopes: [],
    canvasUserId: t.data.user?.id,
  };
}

export function exchangeCanvasCode(input: {
  fetch: FetchLike;
  config: CanvasOAuthConfig;
  code: string;
  codeVerifier: string;
  now: Date;
}) {
  return tokenRequest(
    input.fetch,
    input.config.origin,
    {
      grant_type: "authorization_code",
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      redirect_uri: input.config.redirectUri,
      code: input.code,
      code_verifier: input.codeVerifier,
    },
    input.now,
  );
}

export function refreshCanvasToken(input: {
  fetch: FetchLike;
  config: CanvasOAuthConfig;
  refreshToken: string;
  now: Date;
}) {
  return tokenRequest(
    input.fetch,
    input.config.origin,
    {
      grant_type: "refresh_token",
      client_id: input.config.clientId,
      client_secret: input.config.clientSecret,
      refresh_token: input.refreshToken,
    },
    input.now,
  );
}

/** DELETE /login/oauth2/token with the access token. Reports the real outcome. */
export async function revokeCanvasToken(input: {
  fetch: FetchLike;
  origin: string;
  accessToken: string;
}): Promise<"revoked" | "failed"> {
  try {
    const res = await input.fetch(new URL("/login/oauth2/token", input.origin).toString(), {
      method: "DELETE",
      headers: { authorization: `Bearer ${input.accessToken}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    return res.ok ? "revoked" : "failed";
  } catch {
    return "failed";
  }
}
