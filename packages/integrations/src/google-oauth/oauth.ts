/**
 * Google OAuth 2.0 (web-server flow) helpers for the Google Tasks connection.
 *
 * Endpoints are fixed constants: nothing here accepts a URL from users, tasks, or providers.
 * Requests never follow redirects, so credentials cannot be forwarded to another host.
 * Reference: https://developers.google.com/identity/protocols/oauth2/web-server
 */
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { ProviderError } from "../errors.ts";
import { DEFAULT_TIMEOUT_MS, retryAfterMs, type FetchLike } from "../http.ts";

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";

export const TASKS_READONLY_SCOPE = "https://www.googleapis.com/auth/tasks.readonly";
/** `openid` yields the account's stable `sub`, used to identify the connected account. */
export const GOOGLE_TASKS_READ_SCOPES = ["openid", TASKS_READONLY_SCOPE] as const;

const VALID_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export interface GoogleOAuthClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

// ---- PKCE (RFC 7636) ------------------------------------------------------------------------

export function createCodeVerifier(): string {
  return randomBytes(32).toString("base64url"); // 43 chars, within 43..128
}

export function codeChallengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createStateToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashStateToken(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

// ---- authorization request ------------------------------------------------------------------

export function buildAuthorizationUrl(input: {
  config: GoogleOAuthClientConfig;
  state: string;
  codeChallenge: string;
  scopes: readonly string[];
  /** Ask for consent again so Google issues a refresh token (only when none is stored). */
  forceConsent: boolean;
  loginHint?: string;
}): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  const p = url.searchParams;
  p.set("client_id", input.config.clientId);
  p.set("redirect_uri", input.config.redirectUri);
  p.set("response_type", "code");
  p.set("scope", input.scopes.join(" "));
  p.set("access_type", "offline");
  p.set("state", input.state);
  p.set("code_challenge", input.codeChallenge);
  p.set("code_challenge_method", "S256");
  // Keep this grant separate from the sign-in grant (no scope merging).
  p.set("include_granted_scopes", "false");
  if (input.forceConsent) p.set("prompt", "consent");
  if (input.loginHint) p.set("login_hint", input.loginHint);
  return url.toString();
}

// ---- token endpoint -------------------------------------------------------------------------

const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(4096),
  expires_in: z
    .number()
    .int()
    .positive()
    .max(86_400 * 7)
    .optional(),
  refresh_token: z.string().min(1).max(4096).optional(),
  scope: z.string().max(4096).default(""),
  token_type: z.string(),
  id_token: z.string().max(16_384).optional(),
});

export interface TokenSet {
  accessToken: string;
  accessTokenExpiresAt: Date | null;
  refreshToken?: string;
  scopes: string[];
  idToken?: string;
}

async function postForm(
  fetchImpl: FetchLike,
  url: string,
  form: Record<string, string>,
): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    throw new ProviderError(
      "retryable",
      name === "TimeoutError" ? "oauth_timeout" : "oauth_network_error",
    );
  }
}

async function readTokenResponse(res: Response, now: Date): Promise<TokenSet> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new ProviderError(res.status >= 500 ? "retryable" : "fatal", `oauth_http_${res.status}`);
  }
  if (!res.ok) {
    const error =
      typeof (body as { error?: unknown })?.error === "string"
        ? (body as { error: string }).error
        : "";
    if (res.status === 429 || res.status >= 500) {
      throw new ProviderError(
        "retryable",
        `oauth_http_${res.status}`,
        undefined,
        retryAfterMs(res.headers.get("retry-after")),
      );
    }
    if (error === "invalid_grant") throw new ProviderError("auth", "invalid_grant");
    if (error === "invalid_client" || error === "unauthorized_client") {
      throw new ProviderError("fatal", "oauth_client_misconfigured");
    }
    throw new ProviderError(
      "fatal",
      error ? `oauth_${error.replace(/[^a-z_]/g, "").slice(0, 40)}` : `oauth_http_${res.status}`,
    );
  }
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new ProviderError("fatal", "oauth_invalid_token_response");
  }
  const t = parsed.data;
  return {
    accessToken: t.access_token,
    accessTokenExpiresAt: t.expires_in ? new Date(now.getTime() + t.expires_in * 1000) : null,
    refreshToken: t.refresh_token,
    scopes: t.scope.split(/\s+/).filter(Boolean),
    idToken: t.id_token,
  };
}

export async function exchangeAuthorizationCode(input: {
  fetch: FetchLike;
  config: GoogleOAuthClientConfig;
  code: string;
  codeVerifier: string;
  now: Date;
}): Promise<TokenSet> {
  const res = await postForm(input.fetch, GOOGLE_TOKEN_ENDPOINT, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.config.redirectUri,
  });
  return readTokenResponse(res, input.now);
}

export async function refreshAccessToken(input: {
  fetch: FetchLike;
  config: Pick<GoogleOAuthClientConfig, "clientId" | "clientSecret">;
  refreshToken: string;
  now: Date;
}): Promise<TokenSet> {
  const res = await postForm(input.fetch, GOOGLE_TOKEN_ENDPOINT, {
    grant_type: "refresh_token",
    refresh_token: input.refreshToken,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
  });
  return readTokenResponse(res, input.now);
}

/**
 * Revoke a token at Google. Returns the real outcome; callers must report failures honestly
 * rather than claiming the grant was revoked.
 */
export async function revokeToken(input: {
  fetch: FetchLike;
  token: string;
}): Promise<"revoked" | "failed"> {
  try {
    const res = await postForm(input.fetch, GOOGLE_REVOCATION_ENDPOINT, { token: input.token });
    return res.ok ? "revoked" : "failed";
  } catch {
    return "failed";
  }
}

// ---- ID token claims ------------------------------------------------------------------------

const idTokenClaimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1).max(255),
  exp: z.number(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
});

/**
 * Read the claims of an ID token received directly from Google's token endpoint over TLS.
 * Per OpenID Connect Core §3.1.3.7, TLS server validation may stand in for signature checks in
 * that case; issuer, audience and expiry are still verified here.
 */
export function readIdTokenClaims(idToken: string, clientId: string, now: Date) {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new ProviderError("fatal", "oauth_invalid_id_token");
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    throw new ProviderError("fatal", "oauth_invalid_id_token");
  }
  const claims = idTokenClaimsSchema.safeParse(payload);
  if (!claims.success) throw new ProviderError("fatal", "oauth_invalid_id_token");
  const c = claims.data;
  const audiences = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!VALID_ISSUERS.has(c.iss)) throw new ProviderError("fatal", "oauth_id_token_issuer");
  if (!audiences.includes(clientId)) throw new ProviderError("fatal", "oauth_id_token_audience");
  if (c.exp * 1000 < now.getTime() - 60_000)
    throw new ProviderError("fatal", "oauth_id_token_expired");
  return { sub: c.sub, email: c.email, emailVerified: c.email_verified };
}
