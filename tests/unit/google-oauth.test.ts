import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  codeChallengeS256,
  createCodeVerifier,
  exchangeAuthorizationCode,
  GOOGLE_TOKEN_ENDPOINT,
  hashStateToken,
  ProviderError,
  readIdTokenClaims,
  refreshAccessToken,
  revokeToken,
  TASKS_READONLY_SCOPE,
} from "@scholar/integrations";

const config = {
  clientId: "client-123",
  clientSecret: "secret-xyz",
  redirectUri: "http://localhost:3000/api/v1/integrations/google/callback",
};
const now = new Date("2026-11-04T15:00:00Z");
const respond = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("PKCE and state", () => {
  it("derives an S256 challenge matching an independent implementation", async () => {
    const verifier = createCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const digest = Buffer.from(
      await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    expect(codeChallengeS256(verifier)).toBe(digest.toString("base64url"));
  });

  it("stores only a hash of the state token", () => {
    expect(hashStateToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
  });
});

describe("authorization URL", () => {
  it("requests read-only Tasks + openid, offline access, PKCE, and no scope merging", () => {
    const url = new URL(
      buildAuthorizationUrl({
        config,
        state: "st",
        codeChallenge: "ch",
        scopes: ["openid", TASKS_READONLY_SCOPE],
        forceConsent: true,
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const p = url.searchParams;
    expect(p.get("scope")).toBe(`openid ${TASKS_READONLY_SCOPE}`);
    expect(p.get("scope")).not.toMatch(/auth\/tasks(\s|$)/);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("include_granted_scopes")).toBe("false");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("redirect_uri")).toBe(config.redirectUri);
    expect(p.has("client_secret")).toBe(false);
  });

  it("does not force consent when a refresh token is already held", () => {
    const url = new URL(
      buildAuthorizationUrl({
        config,
        state: "s",
        codeChallenge: "c",
        scopes: ["openid"],
        forceConsent: false,
      }),
    );
    expect(url.searchParams.has("prompt")).toBe(false);
  });
});

describe("token endpoint", () => {
  it("posts a form to the fixed endpoint without following redirects", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(200, {
        access_token: "at",
        expires_in: 3600,
        refresh_token: "rt",
        token_type: "Bearer",
        scope: `openid ${TASKS_READONLY_SCOPE}`,
      });
    };
    const t = await exchangeAuthorizationCode({
      fetch,
      config,
      code: "c0de",
      codeVerifier: "v",
      now,
    });
    expect(calls[0]!.url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(calls[0]!.init.redirect).toBe("error");
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(Object.fromEntries(form)).toMatchObject({
      grant_type: "authorization_code",
      code: "c0de",
      code_verifier: "v",
    });
    expect(t.accessTokenExpiresAt?.toISOString()).toBe("2026-11-04T16:00:00.000Z");
    expect(t.scopes).toContain(TASKS_READONLY_SCOPE);
  });

  it("classifies failures without leaking tokens", async () => {
    const cases: Array<[number, unknown, string, string]> = [
      [400, { error: "invalid_grant" }, "auth", "invalid_grant"],
      [401, { error: "invalid_client" }, "fatal", "oauth_client_misconfigured"],
      [503, { error: "backend_error" }, "retryable", "oauth_http_503"],
      [200, { access_token: "x", token_type: "mac" }, "fatal", "oauth_invalid_token_response"],
    ];
    for (const [status, body, kind, code] of cases) {
      const err = await refreshAccessToken({
        fetch: async () => respond(status, body),
        config,
        refreshToken: "1//super-secret-refresh",
        now,
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err).toMatchObject({ kind, code });
      expect(String((err as Error).message)).not.toContain("super-secret");
    }
    const net = await refreshAccessToken({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
      config,
      refreshToken: "r",
      now,
    }).catch((e: unknown) => e);
    expect(net).toMatchObject({ kind: "retryable", code: "oauth_network_error" });
  });

  it("reports revocation outcomes truthfully", async () => {
    expect(
      await revokeToken({ fetch: async () => new Response(null, { status: 200 }), token: "t" }),
    ).toBe("revoked");
    expect(
      await revokeToken({ fetch: async () => new Response(null, { status: 400 }), token: "t" }),
    ).toBe("failed");
    expect(
      await revokeToken({
        fetch: async () => {
          throw new Error("down");
        },
        token: "t",
      }),
    ).toBe("failed");
  });
});

describe("ID token claims", () => {
  const make = (claims: Record<string, unknown>) =>
    ["e30", Buffer.from(JSON.stringify(claims)).toString("base64url"), "sig"].join(".");
  const good = {
    iss: "https://accounts.google.com",
    aud: "client-123",
    sub: "123",
    exp: now.getTime() / 1000 + 600,
  };

  it("accepts Google-issued tokens for this client", () => {
    expect(readIdTokenClaims(make(good), "client-123", now).sub).toBe("123");
  });

  it("rejects wrong audience, issuer, expired or malformed tokens", () => {
    expect(() => readIdTokenClaims(make({ ...good, aud: "other" }), "client-123", now)).toThrow(
      /audience/,
    );
    expect(() =>
      readIdTokenClaims(make({ ...good, iss: "https://evil.example" }), "client-123", now),
    ).toThrow(/issuer/);
    expect(() =>
      readIdTokenClaims(make({ ...good, exp: now.getTime() / 1000 - 3600 }), "client-123", now),
    ).toThrow(/expired/);
    expect(() => readIdTokenClaims("not-a-jwt", "client-123", now)).toThrow();
  });
});
