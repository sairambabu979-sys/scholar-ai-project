/**
 * Canvas connection lifecycle for ONE configured, institution-approved origin (milestone M2).
 * Uses the shared OAuth transaction, sealed token storage and serialized refresh. Read-only:
 * the requested scopes cover GET endpoints only.
 */
import {
  cancelJobsForIntegration,
  enqueueJob,
  recordAudit,
  syncDedupeKey,
  type Db,
} from "@scholar/db";
import type { Clock } from "@scholar/domain";
import {
  buildCanvasAuthorizationUrl,
  codeChallengeS256,
  exchangeCanvasCode,
  ProviderError,
  refreshCanvasToken,
  revokeCanvasToken,
  type AccessTokenProvider,
  type CanvasOAuthConfig,
  type FetchLike,
} from "@scholar/integrations";
import type { Keyring, Logger } from "@scholar/security";
import { consumeOAuthTransaction, createOAuthTransaction, type ReturnPath } from "./oauth-state.ts";
import { createTokenProvider, type TokenProviderDeps } from "./token-provider.ts";
import { openTokens, writeEnvelope } from "./token-store.ts";

export const CANVAS_PROVIDER = "canvas";
export const CANVAS_SYNC_JOB = "canvas.sync";

export interface CanvasConnectionDeps {
  db: Db;
  keyring: Keyring;
  /** Guarded fetch restricted to the Canvas origin (connect-time DNS checks, no redirects). */
  fetch: FetchLike;
  clock: Clock;
  oauth: CanvasOAuthConfig;
  appOrigin: string;
  logger?: Logger;
}

export async function startCanvasConnection(
  deps: CanvasConnectionDeps,
  input: { userId: string; sessionId: string; returnPath: ReturnPath; requestId?: string },
): Promise<{ authorizationUrl: string }> {
  const now = deps.clock.now();
  const { state, codeVerifier } = await createOAuthTransaction(deps.db, deps.keyring, {
    provider: CANVAS_PROVIDER,
    userId: input.userId,
    sessionId: input.sessionId,
    appOrigin: deps.appOrigin,
    redirectUri: deps.oauth.redirectUri,
    scopes: deps.oauth.scopes,
    returnPath: input.returnPath,
    now,
  });
  await recordAudit(deps.db, {
    userId: input.userId,
    actor: "user",
    action: "integration.connect_started",
    metadata: {
      provider: CANVAS_PROVIDER,
      origin: deps.oauth.origin,
      scopes: [...deps.oauth.scopes],
    },
    requestId: input.requestId,
  });
  return {
    authorizationUrl: buildCanvasAuthorizationUrl({
      config: deps.oauth,
      state,
      codeChallenge: codeChallengeS256(codeVerifier),
    }),
  };
}

export type CanvasCallbackFailure =
  | "invalid_state"
  | "state_mismatch"
  | "state_expired"
  | "denied"
  | "provider_error"
  | "invalid_request"
  | "token_exchange_failed"
  | "identity_missing"
  | "different_account"
  | "missing_refresh_token";

export type CanvasCallbackResult =
  | { ok: true; integrationId: string; jobId: string; returnPath: ReturnPath }
  | { ok: false; reason: CanvasCallbackFailure; returnPath: ReturnPath };

export async function completeCanvasConnection(
  deps: CanvasConnectionDeps,
  input: {
    userId: string;
    sessionId: string;
    state: string | null;
    code: string | null;
    error: string | null;
    requestId?: string;
  },
): Promise<CanvasCallbackResult> {
  const now = deps.clock.now();
  const fail = async (
    reason: CanvasCallbackFailure,
    returnPath: ReturnPath = "/onboarding",
  ): Promise<CanvasCallbackResult> => {
    await recordAudit(deps.db, {
      userId: input.userId,
      actor: "user",
      action: "integration.connect_failed",
      metadata: { provider: CANVAS_PROVIDER, reason },
      requestId: input.requestId,
    }).catch(() => undefined);
    return { ok: false, reason, returnPath };
  };

  const consumed = await consumeOAuthTransaction(deps.db, deps.keyring, {
    provider: CANVAS_PROVIDER,
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
    tokens = await exchangeCanvasCode({
      fetch: deps.fetch,
      config: deps.oauth,
      code: input.code,
      codeVerifier: consumed.codeVerifier,
      now,
    });
  } catch (e) {
    deps.logger?.warn("canvas.oauth.exchange_failed", {
      code: e instanceof ProviderError ? e.code : "error",
    });
    return fail("token_exchange_failed", returnPath);
  }
  const discard = () =>
    revokeCanvasToken({
      fetch: deps.fetch,
      origin: deps.oauth.origin,
      accessToken: tokens.accessToken,
    });
  if (!tokens.canvasUserId || !/^\d{1,20}$/.test(tokens.canvasUserId)) {
    await discard();
    return fail("identity_missing", returnPath);
  }
  if (!tokens.refreshToken) {
    await discard();
    return fail("missing_refresh_token", returnPath);
  }
  const externalAccountId = `canvas:${deps.oauth.origin}:${tokens.canvasUserId}`;

  class Abort extends Error {
    constructor(readonly reason: CanvasCallbackFailure) {
      super(reason);
    }
  }
  let integrationId: string;
  try {
    integrationId = await deps.db.$transaction(async (tx) => {
      const other = await tx.integration.findFirst({
        where: {
          userId: input.userId,
          provider: "canvas",
          mode: "live",
          status: { not: "disconnected" },
          externalAccountId: { not: externalAccountId },
        },
        select: { id: true },
      });
      if (other) throw new Abort("different_account");
      const integration = await tx.integration.upsert({
        where: {
          userId_provider_externalAccountId: {
            userId: input.userId,
            provider: "canvas",
            externalAccountId,
          },
        },
        create: {
          userId: input.userId,
          provider: "canvas",
          mode: "live",
          status: "active",
          externalAccountId,
          baseUrl: deps.oauth.origin,
          scopes: [...deps.oauth.scopes],
        },
        update: {
          mode: "live",
          status: "active",
          baseUrl: deps.oauth.origin,
          scopes: [...deps.oauth.scopes],
          connectedAt: now,
          disconnectedAt: null,
          lastErrorCode: null,
          lastErrorAt: null,
        },
        select: { id: true },
      });
      await writeEnvelope(tx, deps.keyring, {
        userId: input.userId,
        integrationId: integration.id,
        payload: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        grantedScopes: [...deps.oauth.scopes],
        provider: "canvas",
      });
      // Synthetic Canvas fixtures never mix with a real account.
      const mocks = await tx.integration.findMany({
        where: {
          userId: input.userId,
          provider: "canvas",
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
        await tx.taskLink.deleteMany({
          where: { userId: input.userId, assignment: { integrationId: m.id } },
        });
        await tx.assignment.deleteMany({ where: { userId: input.userId, integrationId: m.id } });
        await tx.course.deleteMany({ where: { userId: input.userId, integrationId: m.id } });
      }
      await recordAudit(tx, {
        userId: input.userId,
        actor: "user",
        action: "integration.connected",
        targetType: "integration",
        targetId: integration.id,
        metadata: {
          provider: "canvas",
          mode: "live",
          origin: deps.oauth.origin,
          retiredMockIntegrations: mocks.length,
        },
        requestId: input.requestId,
      });
      return integration.id;
    });
  } catch (e) {
    if (e instanceof Abort) {
      await discard();
      return fail(e.reason, returnPath);
    }
    throw e;
  }

  const job = await enqueueJob(deps.db, {
    userId: input.userId,
    kind: CANVAS_SYNC_JOB,
    dedupeKey: syncDedupeKey(integrationId),
    payload: { integrationId, trigger: "initial" },
    runAt: now,
  });
  return { ok: true, integrationId, jobId: job.id, returnPath };
}

export function createCanvasTokenProvider(
  deps: TokenProviderDeps & { fetch: FetchLike; oauth: CanvasOAuthConfig },
  integration: { id: string; userId: string },
): AccessTokenProvider {
  return createTokenProvider(deps, integration, "canvas", (refreshToken) =>
    refreshCanvasToken({
      fetch: deps.fetch,
      config: deps.oauth,
      refreshToken,
      now: deps.clock.now(),
    }),
  );
}

/** Revoke a Canvas grant from a sealed envelope. Never throws; reports the real outcome. */
export async function revokeCanvasEnvelope(input: {
  keyring: Keyring;
  fetch: FetchLike;
  origin: string;
  userId: string;
  integrationId: string;
  sealedPayload: string;
}): Promise<"revoked" | "failed"> {
  try {
    const t = openTokens(
      input.keyring,
      input.userId,
      input.integrationId,
      input.sealedPayload,
      "canvas",
    );
    return await revokeCanvasToken({
      fetch: input.fetch,
      origin: input.origin,
      accessToken: t.accessToken,
    });
  } catch {
    return "failed";
  }
}
