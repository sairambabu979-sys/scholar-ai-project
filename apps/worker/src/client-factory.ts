import { isValidDateOnly, todayInTimeZone, type Clock } from "@scholar/domain";
import { ProviderError, type GoogleTasksReadClient } from "@scholar/integrations";
import { buildMockGoogleTasksDataset, MockGoogleTasksClient } from "@scholar/testing";
import type { IntegrationsMode } from "@scholar/config";

/**
 * Select the Google Tasks client for an integration. A mock integration only ever gets the
 * labelled mock client; a live integration never silently falls back to fixtures.
 */
export function createGoogleTasksClientFactory(opts: {
  integrationsMode: IntegrationsMode;
  clock: Clock;
}) {
  return async (integration: {
    id: string;
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
    // Phase 2 (M1): live OAuth client with encrypted token envelopes.
    throw new ProviderError("unavailable", "live_google_tasks_not_implemented");
  };
}
