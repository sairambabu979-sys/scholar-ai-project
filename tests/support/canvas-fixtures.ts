import { randomBytes } from "node:crypto";
import { connectMockCanvas, type Db } from "@scholar/db";
import { CANVAS_DEFAULT_SCOPES } from "@scholar/integrations";
import { Keyring } from "@scholar/security";
import type { CanvasConnectionDeps } from "@scholar/services";
import {
  buildMockCanvasDataset,
  FakeCanvas,
  FixedClock,
  MOCK_CANVAS_ORIGIN,
  MockCanvasClient,
} from "@scholar/testing";
import { createCanvasClientFactory } from "../../apps/worker/src/client-factory.ts";
import { silentLogger } from "./db-helpers.ts";

export const ANCHOR = "2026-11-04";

/** Mock-mode Canvas harness: synthetic data served by an inspectable MockCanvasClient. */
export async function mockCanvas(db: Db, userId: string) {
  const clock = new FixedClock("2026-11-04T15:00:00.000Z");
  const client = new MockCanvasClient(buildMockCanvasDataset(ANCHOR));
  const integration = await connectMockCanvas(db, userId, ANCHOR, MOCK_CANVAS_ORIGIN);
  const deps = { db, clock, logger: silentLogger, clientFor: async () => client };
  return {
    clock,
    client,
    integration,
    deps,
    input: { userId, integrationId: integration.id, trigger: "manual" as const },
  };
}

/** Live-mode Canvas harness against the fake HTTP Canvas. */
export function liveCanvas(db: Db) {
  const clock = new FixedClock("2026-11-04T15:00:00.000Z");
  const keyring = new Keyring({ id: "test-k1", key: randomBytes(32) });
  const oauth = {
    origin: MOCK_CANVAS_ORIGIN,
    clientId: "canvas-client-id",
    clientSecret: "canvas-client-secret",
    redirectUri: "http://localhost:3100/api/v1/integrations/canvas/callback",
    scopes: [...CANVAS_DEFAULT_SCOPES],
  };
  const fake = new FakeCanvas({
    origin: MOCK_CANVAS_ORIGIN,
    clientId: oauth.clientId,
    clientSecret: oauth.clientSecret,
    clock,
    data: buildMockCanvasDataset(ANCHOR),
  });
  const deps: CanvasConnectionDeps = {
    db,
    keyring,
    fetch: fake.fetch,
    clock,
    oauth,
    appOrigin: "http://localhost:3100",
    logger: silentLogger,
  };
  const clientFor = createCanvasClientFactory({
    integrationsMode: "live",
    clock,
    live: { db, keyring, fetch: fake.fetch, oauth },
  });
  return { clock, keyring, oauth, fake, deps, clientFor };
}
