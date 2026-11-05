import { randomBytes } from "node:crypto";
import type { Db } from "@scholar/db";
import { Keyring } from "@scholar/security";
import type { GoogleConnectionDeps } from "@scholar/services";
import {
  buildMockGoogleTasksDataset,
  FakeGoogle,
  FixedClock,
  MockGoogleTasksClient,
} from "@scholar/testing";
import { silentLogger } from "./db-helpers.ts";

export const OAUTH = {
  clientId: "test-client-id.apps.example",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:3100/api/v1/integrations/google/callback",
};
export const APP_ORIGIN = "http://localhost:3100";

export function googleHarness(db: Db) {
  const clock = new FixedClock("2026-11-04T15:00:00.000Z");
  const keyring = new Keyring({ id: "test-k1", key: randomBytes(32) });
  const tasks = new MockGoogleTasksClient(buildMockGoogleTasksDataset("2026-11-04"), { clock });
  const google = new FakeGoogle({
    clock,
    clientId: OAUTH.clientId,
    clientSecret: OAUTH.clientSecret,
    tasks,
  });
  const deps: GoogleConnectionDeps = {
    db,
    keyring,
    fetch: google.fetch,
    clock,
    oauth: OAUTH,
    appOrigin: APP_ORIGIN,
    logger: silentLogger,
  };
  return { clock, keyring, tasks, google, deps };
}

/** Pull state + PKCE challenge out of the authorization URL the app produced. */
export function parseAuthorizationUrl(url: string) {
  const u = new URL(url);
  return {
    state: u.searchParams.get("state")!,
    codeChallenge: u.searchParams.get("code_challenge")!,
    scope: u.searchParams.get("scope")!,
    prompt: u.searchParams.get("prompt"),
  };
}
