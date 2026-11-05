/**
 * Access-token provider for any OAuth integration (Google Tasks, Canvas).
 *
 * Refreshes are serialized per connection with a row lock on the token envelope: concurrent
 * workers that find the token expired (or rejected) queue on the lock, and all but the first
 * reuse the token the first one obtained. Rotated refresh tokens are persisted; an
 * `invalid_grant` erases the dead credentials and marks the connection `needs_reconnect`.
 */
import type { Db } from "@scholar/db";
import { recordAudit } from "@scholar/db";
import type { Clock } from "@scholar/domain";
import { ProviderError, type AccessTokenProvider, type TokenSet } from "@scholar/integrations";
import type { Keyring } from "@scholar/security";
import { openTokens, sealTokens, type CredentialProvider } from "./token-store.ts";

/** Refresh this long before the provider's stated expiry. */
export const ACCESS_TOKEN_SKEW_MS = 60_000;

export interface TokenProviderDeps {
  db: Db;
  keyring: Keyring;
  clock: Clock;
}

interface EnvelopeRow {
  sealed_payload: string;
  access_token_expires_at: Date | null;
  token_version: number;
  granted_scopes: string[];
}

export function createTokenProvider(
  deps: TokenProviderDeps,
  integration: { id: string; userId: string },
  provider: CredentialProvider,
  refresh: (refreshToken: string) => Promise<TokenSet>,
): AccessTokenProvider {
  const fresh = (expiresAt: Date | null) =>
    expiresAt !== null && expiresAt.getTime() - ACCESS_TOKEN_SKEW_MS > deps.clock.now().getTime();

  async function refreshLocked(rejectedVersion: number | null) {
    let deadGrant = false;
    const result = await deps.db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<EnvelopeRow[]>`
          SELECT sealed_payload, access_token_expires_at, token_version, granted_scopes
          FROM token_envelopes
          WHERE integration_id = ${integration.id}::uuid AND user_id = ${integration.userId}::uuid
          FOR UPDATE`;
        const row = rows[0];
        if (!row) throw new ProviderError("auth", "no_credentials");
        const current = openTokens(
          deps.keyring,
          integration.userId,
          integration.id,
          row.sealed_payload,
          provider,
        );
        // Someone else refreshed while we waited for the lock: use their token.
        const othersRefreshed =
          rejectedVersion !== null
            ? row.token_version !== rejectedVersion
            : fresh(row.access_token_expires_at);
        if (othersRefreshed)
          return { accessToken: current.accessToken, tokenVersion: row.token_version };
        if (!current.refreshToken) throw new ProviderError("auth", "no_refresh_token");

        let next: TokenSet;
        try {
          next = await refresh(current.refreshToken);
        } catch (e) {
          if (e instanceof ProviderError && e.code === "invalid_grant") {
            deadGrant = true;
            return null;
          }
          throw e;
        }
        const payload = {
          accessToken: next.accessToken,
          refreshToken: next.refreshToken ?? current.refreshToken,
        };
        const { sealedPayload, keyId } = sealTokens(
          deps.keyring,
          integration.userId,
          integration.id,
          payload,
          provider,
        );
        const updated = await tx.tokenEnvelope.update({
          where: { integrationId: integration.id },
          data: {
            sealedPayload,
            keyId,
            accessTokenExpiresAt: next.accessTokenExpiresAt,
            hasRefreshToken: true,
            grantedScopes: next.scopes.length > 0 ? next.scopes : row.granted_scopes,
            tokenVersion: { increment: 1 },
          },
          select: { tokenVersion: true },
        });
        return { accessToken: next.accessToken, tokenVersion: updated.tokenVersion };
      },
      { timeout: 30_000, maxWait: 30_000 },
    );

    if (deadGrant || !result) {
      // Revoked or expired grant: erase it and ask the student to reconnect; never keep retrying.
      await deps.db.$transaction([
        deps.db.tokenEnvelope.deleteMany({
          where: { integrationId: integration.id, userId: integration.userId },
        }),
        deps.db.integration.updateMany({
          where: { id: integration.id, userId: integration.userId },
          data: {
            status: "needs_reconnect",
            lastErrorCode: "invalid_grant",
            lastErrorAt: deps.clock.now(),
          },
        }),
      ]);
      await recordAudit(deps.db, {
        userId: integration.userId,
        actor: "worker",
        action: "integration.credentials_rejected",
        targetType: "integration",
        targetId: integration.id,
        metadata: { code: "invalid_grant", provider },
      });
      throw new ProviderError("auth", "invalid_grant");
    }
    return result;
  }

  return {
    async get() {
      const row = await deps.db.tokenEnvelope.findFirst({
        where: { integrationId: integration.id, userId: integration.userId },
        select: { sealedPayload: true, accessTokenExpiresAt: true, tokenVersion: true },
      });
      if (!row) throw new ProviderError("auth", "no_credentials");
      if (fresh(row.accessTokenExpiresAt)) {
        const t = openTokens(
          deps.keyring,
          integration.userId,
          integration.id,
          row.sealedPayload,
          provider,
        );
        return { accessToken: t.accessToken, tokenVersion: row.tokenVersion };
      }
      return refreshLocked(null);
    },
    refreshAfterRejection(rejectedVersion: number) {
      return refreshLocked(rejectedVersion);
    },
  };
}
