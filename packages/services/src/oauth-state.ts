/**
 * OAuth authorization transactions shared by every provider (Google Tasks, Canvas).
 *
 * A transaction is single-use, expires after 10 minutes, and is bound to the user, their
 * session, the provider, the configured app origin and the redirect URI. Only a SHA-256 hash of
 * the `state` value is stored; the PKCE verifier is sealed with AAD bound to that hash.
 * Consumption is one atomic UPDATE, so concurrent or replayed callbacks cannot both succeed,
 * and a mismatched attempt still burns the state.
 */
import type { Db } from "@scholar/db";
import { createCodeVerifier, createStateToken, hashStateToken } from "@scholar/integrations";
import { open, seal, type Keyring } from "@scholar/security";

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
export const RETURN_PATHS = ["/onboarding", "/settings"] as const;
export type ReturnPath = (typeof RETURN_PATHS)[number];

const verifierAad = (provider: string, stateHash: string) => `oauth_state:${provider}:${stateHash}`;

export const asReturnPath = (p: string | undefined): ReturnPath =>
  (RETURN_PATHS as readonly string[]).includes(p ?? "") ? (p as ReturnPath) : "/onboarding";

export async function createOAuthTransaction(
  db: Db,
  keyring: Keyring,
  input: {
    provider: string;
    userId: string;
    sessionId: string;
    appOrigin: string;
    redirectUri: string;
    scopes: readonly string[];
    returnPath: ReturnPath;
    now: Date;
  },
): Promise<{ state: string; codeVerifier: string }> {
  const state = createStateToken();
  const stateHash = hashStateToken(state);
  const codeVerifier = createCodeVerifier();
  await db.$transaction([
    db.oAuthState.deleteMany({
      where: {
        userId: input.userId,
        expiresAt: { lt: new Date(input.now.getTime() - 60 * 60_000) },
      },
    }),
    db.oAuthState.create({
      data: {
        userId: input.userId,
        sessionId: input.sessionId,
        provider: input.provider,
        stateHash,
        sealedCodeVerifier: seal(keyring, codeVerifier, verifierAad(input.provider, stateHash)),
        appOrigin: input.appOrigin,
        redirectUri: input.redirectUri,
        requestedScopes: [...input.scopes],
        returnPath: input.returnPath,
        expiresAt: new Date(input.now.getTime() + OAUTH_STATE_TTL_MS),
      },
    }),
  ]);
  return { state, codeVerifier };
}

interface ConsumedState {
  user_id: string;
  session_id: string;
  provider: string;
  state_hash: string;
  sealed_code_verifier: string;
  app_origin: string;
  redirect_uri: string;
  return_path: string;
  expires_at: Date;
}

export type ConsumeResult =
  | { ok: true; codeVerifier: string; returnPath: ReturnPath }
  | {
      ok: false;
      reason: "invalid_state" | "state_mismatch" | "state_expired";
      returnPath: ReturnPath;
    };

export async function consumeOAuthTransaction(
  db: Db,
  keyring: Keyring,
  input: {
    provider: string;
    state: string | null;
    userId: string;
    sessionId: string;
    appOrigin: string;
    redirectUri: string;
    now: Date;
  },
): Promise<ConsumeResult> {
  if (!input.state || input.state.length > 512)
    return { ok: false, reason: "invalid_state", returnPath: "/onboarding" };
  const stateHash = hashStateToken(input.state);
  const rows = await db.$queryRaw<ConsumedState[]>`
    UPDATE oauth_states SET consumed_at = ${input.now}::timestamptz
    WHERE state_hash = ${stateHash} AND consumed_at IS NULL
    RETURNING user_id, session_id, provider, state_hash, sealed_code_verifier, app_origin,
              redirect_uri, return_path, expires_at`;
  const st = rows[0];
  if (!st) return { ok: false, reason: "invalid_state", returnPath: "/onboarding" };
  const returnPath = asReturnPath(st.return_path);
  if (
    st.user_id !== input.userId ||
    st.session_id !== input.sessionId ||
    st.provider !== input.provider ||
    st.app_origin !== input.appOrigin ||
    st.redirect_uri !== input.redirectUri
  ) {
    return { ok: false, reason: "state_mismatch", returnPath };
  }
  if (st.expires_at.getTime() <= input.now.getTime())
    return { ok: false, reason: "state_expired", returnPath };
  return {
    ok: true,
    codeVerifier: open(keyring, st.sealed_code_verifier, verifierAad(st.provider, st.state_hash)),
    returnPath,
  };
}
