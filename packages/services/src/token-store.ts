/**
 * Sealed storage for integration credentials (Google Tasks, Canvas). Tokens exist in plaintext
 * only in memory for the duration of a provider call. The AAD binds every envelope to its
 * provider, integration and owner, so an envelope copied to another row cannot be opened.
 */
import type { Db, Prisma } from "@scholar/db";
import { open, seal, sealedKeyId, type Keyring } from "@scholar/security";

export type CredentialProvider = "google_tasks" | "canvas";

export interface TokenPayload {
  accessToken: string;
  refreshToken?: string;
}

export const tokenAad = (
  userId: string,
  integrationId: string,
  provider: CredentialProvider = "google_tasks",
) => `token_envelope:${provider}:${integrationId}:${userId}`;

export function sealTokens(
  keyring: Keyring,
  userId: string,
  integrationId: string,
  payload: TokenPayload,
  provider: CredentialProvider = "google_tasks",
) {
  const sealed = seal(keyring, JSON.stringify(payload), tokenAad(userId, integrationId, provider));
  return { sealedPayload: sealed, keyId: sealedKeyId(sealed)! };
}

export function openTokens(
  keyring: Keyring,
  userId: string,
  integrationId: string,
  sealedPayload: string,
  provider: CredentialProvider = "google_tasks",
): TokenPayload {
  const parsed = JSON.parse(
    open(keyring, sealedPayload, tokenAad(userId, integrationId, provider)),
  ) as TokenPayload;
  if (typeof parsed.accessToken !== "string") throw new Error("Malformed token payload");
  return parsed;
}

export async function writeEnvelope(
  db: Db | Prisma.TransactionClient,
  keyring: Keyring,
  input: {
    userId: string;
    integrationId: string;
    payload: TokenPayload;
    accessTokenExpiresAt: Date | null;
    grantedScopes: string[];
    provider?: CredentialProvider;
  },
) {
  const { sealedPayload, keyId } = sealTokens(
    keyring,
    input.userId,
    input.integrationId,
    input.payload,
    input.provider,
  );
  const data = {
    keyId,
    sealedPayload,
    accessTokenExpiresAt: input.accessTokenExpiresAt,
    hasRefreshToken: Boolean(input.payload.refreshToken),
    grantedScopes: input.grantedScopes,
  };
  return db.tokenEnvelope.upsert({
    where: { integrationId: input.integrationId },
    create: { userId: input.userId, integrationId: input.integrationId, ...data },
    update: { ...data, tokenVersion: { increment: 1 } },
    select: { tokenVersion: true },
  });
}
