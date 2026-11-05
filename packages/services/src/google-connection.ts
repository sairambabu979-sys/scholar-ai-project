/**
 * Google Tasks connection lifecycle (SCHOLAR_AI_PLAN.md §3 Google Tasks, §5, milestone M1).
 *
 * start    → single-use, 10-minute OAuth state bound to user + session + provider + app origin,
 *            PKCE (S256), read-only Tasks scope; returns Google's authorization URL.
 * complete → consumes the state atomically (replays fail), checks every binding, exchanges the
 *            code, requires the Tasks scope and a verified account identity, preserves an
 *            existing refresh token when Google omits one, seals tokens, queues the first sync.
 * disconnect → disables sync, cancels jobs, erases tokens in the same transaction, then tries
 *            revocation at Google and reports the real outcome.
 */
import {
  cancelJobsForIntegration,
  enqueueJob,
  GOOGLE_TASKS_SYNC_JOB,
  recordAudit,
  syncDedupeKey,
  type Db,
} from "@scholar/db";
import type { Clock } from "@scholar/domain";
import {
  buildAuthorizationUrl,
  codeChallengeS256,
  exchangeAuthorizationCode,
  GOOGLE_TASKS_READ_SCOPES,
  ProviderError,
  readIdTokenClaims,
  revokeToken,
  TASKS_READONLY_SCOPE,
  type FetchLike,
  type GoogleOAuthClientConfig,
} from "@scholar/integrations";
import type { Keyring, Logger } from "@scholar/security";
import { openTokens, writeEnvelope } from "./token-store.ts";
import { consumeOAuthTransaction, createOAuthTransaction, type ReturnPath } from "./oauth-state.ts";

export { OAUTH_STATE_TTL_MS, RETURN_PATHS, type ReturnPath } from "./oauth-state.ts";

export const GOOGLE_TASKS_PROVIDER = "google_tasks";

export interface GoogleConnectionDeps {
  db: Db;
  keyring: Keyring;
  fetch: FetchLike;
  clock: Clock;
  oauth: GoogleOAuthClientConfig;
  /** The configured application origin; callbacks for any other origin are rejected. */
  appOrigin: string;
  logger?: Logger;
}

export async function startGoogleTasksConnection(
  deps: GoogleConnectionDeps,
  input: { userId: string; sessionId: string; returnPath: ReturnPath; requestId?: string },
): Promise<{ authorizationUrl: string }> {
  const now = deps.clock.now();

  // Ask Google for consent (and therefore a refresh token) only when we do not hold one.
  const existing = await deps.db.tokenEnvelope.findFirst({
    where: {
      userId: input.userId,
      hasRefreshToken: true,
      integration: { provider: "google_tasks", mode: "live", status: { not: "disconnected" } },
    },
    select: { id: true },
  });

  const { state, codeVerifier: verifier } = await createOAuthTransaction(deps.db, deps.keyring, {
    provider: GOOGLE_TASKS_PROVIDER,
    userId: input.userId,
    sessionId: input.sessionId,
    appOrigin: deps.appOrigin,
    redirectUri: deps.oauth.redirectUri,
    scopes: GOOGLE_TASKS_READ_SCOPES,
    returnPath: input.returnPath,
    now,
  });
  await recordAudit(deps.db, {
    userId: input.userId,
    actor: "user",
    action: "integration.connect_started",
    metadata: {
      provider: "google_tasks",
      scopes: [...GOOGLE_TASKS_READ_SCOPES],
      forceConsent: !existing,
    },
    requestId: input.requestId,
  });

  return {
    authorizationUrl: buildAuthorizationUrl({
      config: deps.oauth,
      state,
      codeChallenge: codeChallengeS256(verifier),
      scopes: GOOGLE_TASKS_READ_SCOPES,
      forceConsent: !existing,
    }),
  };
}

export type CallbackFailure =
  | "invalid_state"
  | "state_mismatch"
  | "state_expired"
  | "denied"
  | "provider_error"
  | "invalid_request"
  | "token_exchange_failed"
  | "scope_not_granted"
  | "identity_missing"
  | "different_account"
  | "missing_refresh_token";

export type CallbackResult =
  | {
      ok: true;
      integrationId: string;
      jobId: string;
      returnPath: ReturnPath;
      refreshTokenPreserved: boolean;
    }
  | { ok: false; reason: CallbackFailure; returnPath: ReturnPath };

export async function completeGoogleTasksConnection(
  deps: GoogleConnectionDeps,
  input: {
    userId: string;
    sessionId: string;
    state: string | null;
    code: string | null;
    error: string | null;
    requestId?: string;
  },
): Promise<CallbackResult> {
  const now = deps.clock.now();
  const fail = async (
    reason: CallbackFailure,
    returnPath: ReturnPath = "/onboarding",
  ): Promise<CallbackResult> => {
    await recordAudit(deps.db, {
      userId: input.userId,
      actor: "user",
      action: "integration.connect_failed",
      metadata: { provider: "google_tasks", reason },
      requestId: input.requestId,
    }).catch(() => undefined);
    return { ok: false, reason, returnPath };
  };

  const consumed = await consumeOAuthTransaction(deps.db, deps.keyring, {
    provider: GOOGLE_TASKS_PROVIDER,
    state: input.state,
    userId: input.userId,
    sessionId: input.sessionId,
    appOrigin: deps.appOrigin,
    redirectUri: deps.oauth.redirectUri,
    now,
  });
  if (!consumed.ok) return fail(consumed.reason, consumed.returnPath);
  const returnPath = consumed.returnPath;
  if (input.error)
    return fail(input.error === "access_denied" ? "denied" : "provider_error", returnPath);
  if (!input.code || input.code.length > 2048) return fail("invalid_request", returnPath);

  let tokens;
  try {
    tokens = await exchangeAuthorizationCode({
      fetch: deps.fetch,
      config: deps.oauth,
      code: input.code,
      codeVerifier: consumed.codeVerifier,
      now,
    });
  } catch (e) {
    deps.logger?.warn("google.oauth.exchange_failed", {
      code: e instanceof ProviderError ? e.code : "error",
    });
    return fail("token_exchange_failed", returnPath);
  }

  const discard = async () => {
    await revokeToken({ fetch: deps.fetch, token: tokens.refreshToken ?? tokens.accessToken });
  };

  // Google's granular consent lets the student untick the Tasks scope; do not keep a grant
  // that cannot do the job.
  if (!tokens.scopes.includes(TASKS_READONLY_SCOPE)) {
    await discard();
    return fail("scope_not_granted", returnPath);
  }
  let sub: string;
  try {
    if (!tokens.idToken) throw new ProviderError("fatal", "oauth_missing_id_token");
    sub = readIdTokenClaims(tokens.idToken, deps.oauth.clientId, now).sub;
  } catch {
    await discard();
    return fail("identity_missing", returnPath);
  }
  const externalAccountId = `google:${sub}`;

  type TxOutcome =
    | { ok: true; integrationId: string; preserved: boolean }
    | { ok: false; reason: CallbackFailure };
  // Failures inside the transaction THROW so every write in it rolls back (no half-connected
  // integration without credentials is ever committed).
  class Abort extends Error {
    constructor(readonly reason: CallbackFailure) {
      super(reason);
    }
  }
  const outcome: TxOutcome = await deps.db
    .$transaction(async (tx) => {
      const otherLive = await tx.integration.findFirst({
        where: {
          userId: input.userId,
          provider: "google_tasks",
          mode: "live",
          status: { not: "disconnected" },
          externalAccountId: { not: externalAccountId },
        },
        select: { id: true },
      });
      if (otherLive) throw new Abort("different_account");

      const integration = await tx.integration.upsert({
        where: {
          userId_provider_externalAccountId: {
            userId: input.userId,
            provider: "google_tasks",
            externalAccountId,
          },
        },
        create: {
          userId: input.userId,
          provider: "google_tasks",
          mode: "live",
          status: "active",
          externalAccountId,
          scopes: tokens.scopes,
        },
        update: {
          mode: "live",
          status: "active",
          scopes: tokens.scopes,
          connectedAt: now,
          disconnectedAt: null,
          lastErrorCode: null,
          lastErrorAt: null,
        },
        select: { id: true },
      });

      // Google may omit refresh_token on re-consent; keep the one we already hold.
      let refreshToken = tokens.refreshToken;
      let preserved = false;
      if (!refreshToken) {
        const prev = await tx.tokenEnvelope.findUnique({
          where: { integrationId: integration.id },
          select: { sealedPayload: true },
        });
        if (prev) {
          refreshToken = openTokens(
            deps.keyring,
            input.userId,
            integration.id,
            prev.sealedPayload,
          ).refreshToken;
          preserved = Boolean(refreshToken);
        }
      }
      if (!refreshToken) throw new Abort("missing_refresh_token");

      await writeEnvelope(tx, deps.keyring, {
        userId: input.userId,
        integrationId: integration.id,
        payload: { accessToken: tokens.accessToken, refreshToken },
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        grantedScopes: tokens.scopes,
      });

      // Synthetic fixtures never mix with a real account: retire any mock connection.
      const mocks = await tx.integration.findMany({
        where: {
          userId: input.userId,
          provider: "google_tasks",
          mode: "mock",
          status: { not: "disconnected" },
        },
        select: { id: true },
      });
      for (const m of mocks) {
        await tx.integration.update({
          where: { id: m.id },
          data: { status: "disconnected", disconnectedAt: now },
        });
        await cancelJobsForIntegration(tx, input.userId, m.id, now);
        await tx.task.deleteMany({ where: { userId: input.userId, integrationId: m.id } });
        await tx.taskList.deleteMany({ where: { userId: input.userId, integrationId: m.id } });
        await tx.syncCursor.deleteMany({ where: { userId: input.userId, integrationId: m.id } });
      }

      await recordAudit(tx, {
        userId: input.userId,
        actor: "user",
        action: "integration.connected",
        targetType: "integration",
        targetId: integration.id,
        metadata: {
          provider: "google_tasks",
          mode: "live",
          scopes: tokens.scopes,
          refreshTokenPreserved: preserved,
          retiredMockIntegrations: mocks.length,
        },
        requestId: input.requestId,
      });
      return { ok: true, integrationId: integration.id, preserved } as const;
    })
    .catch((e: unknown) => {
      if (e instanceof Abort) return { ok: false, reason: e.reason } as const;
      throw e;
    });

  if (!outcome.ok) {
    await discard();
    return fail(outcome.reason, returnPath);
  }

  const job = await enqueueJob(deps.db, {
    userId: input.userId,
    kind: GOOGLE_TASKS_SYNC_JOB,
    dedupeKey: syncDedupeKey(outcome.integrationId),
    payload: { integrationId: outcome.integrationId, trigger: "initial" },
    runAt: now,
  });
  return {
    ok: true,
    integrationId: outcome.integrationId,
    jobId: job.id,
    returnPath,
    refreshTokenPreserved: outcome.preserved,
  };
}
