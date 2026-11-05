/** Access-token provider for a live Google Tasks integration (see token-provider.ts). */
import {
  refreshAccessToken,
  type AccessTokenProvider,
  type FetchLike,
  type GoogleOAuthClientConfig,
} from "@scholar/integrations";
import { createTokenProvider, type TokenProviderDeps } from "./token-provider.ts";

export { ACCESS_TOKEN_SKEW_MS } from "./token-provider.ts";

export interface GoogleTokenDeps extends TokenProviderDeps {
  fetch: FetchLike;
  oauth: Pick<GoogleOAuthClientConfig, "clientId" | "clientSecret">;
}

export function createGoogleTokenProvider(
  deps: GoogleTokenDeps,
  integration: { id: string; userId: string },
): AccessTokenProvider {
  return createTokenProvider(deps, integration, "google_tasks", (refreshToken) =>
    refreshAccessToken({
      fetch: deps.fetch,
      config: deps.oauth,
      refreshToken,
      now: deps.clock.now(),
    }),
  );
}
