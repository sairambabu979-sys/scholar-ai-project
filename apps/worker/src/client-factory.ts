import type { IntegrationsMode } from "@scholar/config";
import type { Db } from "@scholar/db";
import { isValidDateOnly, todayInTimeZone, type Clock } from "@scholar/domain";
import {
  LiveCanvasClient,
  LiveGoogleTasksClient,
  ProviderError,
  type CanvasOAuthConfig,
  type CanvasReadClient,
  type FetchLike,
  type GoogleOAuthClientConfig,
  type GoogleTasksReadClient,
} from "@scholar/integrations";
import type { Keyring } from "@scholar/security";
import { createCanvasTokenProvider, createGoogleTokenProvider } from "@scholar/services";
import {
  buildMockCanvasDataset,
  buildMockGoogleTasksDataset,
  MockCanvasClient,
  MockGoogleTasksClient,
} from "@scholar/testing";

export interface LiveClientDeps {
  db: Db;
  keyring: Keyring;
  fetch: FetchLike;
  oauth: Pick<GoogleOAuthClientConfig, "clientId" | "clientSecret">;
}

/**
 * Select the Google Tasks client for an integration. Mock integrations only ever get the
 * labelled fixture client and only in mock mode; live integrations only ever get the real
 * client and only in live mode. There is no silent fallback in either direction.
 */
export function createGoogleTasksClientFactory(opts: {
  integrationsMode: IntegrationsMode;
  clock: Clock;
  live?: LiveClientDeps;
}) {
  return async (integration: {
    id: string;
    userId?: string;
    mode: "mock" | "live";
    config: unknown;
  }): Promise<GoogleTasksReadClient> => {
    if (integration.mode === "mock") {
      if (opts.integrationsMode !== "mock") {
        throw new ProviderError("unavailable", "mock_integration_in_live_mode");
      }
      const anchor = (integration.config as { mockAnchorDate?: string } | null)?.mockAnchorDate;
      const anchorDate =
        anchor && isValidDateOnly(anchor) ? anchor : todayInTimeZone(opts.clock.now(), "UTC");
      return new MockGoogleTasksClient(buildMockGoogleTasksDataset(anchorDate), {
        clock: opts.clock,
      });
    }
    if (opts.integrationsMode !== "live") {
      throw new ProviderError("unavailable", "live_integration_in_mock_mode");
    }
    if (!opts.live || !integration.userId) {
      throw new ProviderError("unavailable", "live_google_tasks_not_configured");
    }
    const live = opts.live;
    return new LiveGoogleTasksClient({
      fetch: live.fetch,
      tokens: createGoogleTokenProvider(
        {
          db: live.db,
          keyring: live.keyring,
          fetch: live.fetch,
          clock: opts.clock,
          oauth: live.oauth,
        },
        { id: integration.id, userId: integration.userId },
      ),
    });
  };
}

export interface LiveCanvasDeps {
  db: Db;
  keyring: Keyring;
  /** Origin-guarded fetch (connect-time DNS checks, no redirects) for the Canvas origin. */
  fetch: FetchLike;
  oauth: CanvasOAuthConfig;
}

/**
 * Canvas client selection with the same no-fallback rules. A live integration must be on the
 * single configured, approved origin; anything else is refused before any request is made.
 */
export function createCanvasClientFactory(opts: {
  integrationsMode: IntegrationsMode;
  clock: Clock;
  live?: LiveCanvasDeps;
}) {
  return async (integration: {
    id: string;
    userId: string;
    mode: "mock" | "live";
    config: unknown;
    baseUrl: string;
  }): Promise<CanvasReadClient> => {
    if (integration.mode === "mock") {
      if (opts.integrationsMode !== "mock")
        throw new ProviderError("unavailable", "mock_integration_in_live_mode");
      const anchor = (integration.config as { mockAnchorDate?: string } | null)?.mockAnchorDate;
      const anchorDate =
        anchor && isValidDateOnly(anchor) ? anchor : todayInTimeZone(opts.clock.now(), "UTC");
      return new MockCanvasClient(buildMockCanvasDataset(anchorDate));
    }
    if (opts.integrationsMode !== "live")
      throw new ProviderError("unavailable", "live_integration_in_mock_mode");
    if (!opts.live) throw new ProviderError("unavailable", "canvas_not_configured");
    if (integration.baseUrl !== opts.live.oauth.origin)
      throw new ProviderError("unavailable", "canvas_origin_mismatch");
    const live = opts.live;
    return new LiveCanvasClient({
      origin: live.oauth.origin,
      fetch: live.fetch,
      tokens: createCanvasTokenProvider(
        {
          db: live.db,
          keyring: live.keyring,
          clock: opts.clock,
          fetch: live.fetch,
          oauth: live.oauth,
        },
        { id: integration.id, userId: integration.userId },
      ),
    });
  };
}
