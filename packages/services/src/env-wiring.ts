import type { AppEnv } from "@scholar/config";
import type { GoogleOAuthClientConfig } from "@scholar/integrations";
import { Keyring } from "@scholar/security";

/** The token keyring, or null when no encryption key is configured (mock mode only). */
export function keyringFromEnv(env: AppEnv): Keyring | null {
  if (!env.tokenEncryption.keyBase64) return null;
  return Keyring.fromConfig({
    keyId: env.tokenEncryption.keyId,
    keyBase64: env.tokenEncryption.keyBase64,
    previous: env.tokenEncryption.previousKeys,
  });
}

/** Google OAuth client settings for the Tasks connection; null unless fully configured. */
export function googleTasksOAuthFromEnv(env: AppEnv): GoogleOAuthClientConfig | null {
  const g = env.google;
  if (!g.clientId || !g.clientSecret || !g.tasksRedirectUri) return null;
  return { clientId: g.clientId, clientSecret: g.clientSecret, redirectUri: g.tasksRedirectUri };
}
