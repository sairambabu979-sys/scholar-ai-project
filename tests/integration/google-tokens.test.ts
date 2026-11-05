import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { open } from "@scholar/security";
import {
  completeGoogleTasksConnection,
  createGoogleTokenProvider,
  startGoogleTasksConnection,
  tokenAad,
} from "@scholar/services";
import { createHash } from "node:crypto";
import { createUser, resetDatabase, testDb } from "../support/db-helpers.ts";
import { googleHarness, parseAuthorizationUrl } from "../support/google-fixtures.ts";

const db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDatabase(db));

async function connected() {
  const h = googleHarness(db);
  const user = await createUser(db, `t${Math.random()}@scholar.example`);
  const { authorizationUrl } = await startGoogleTasksConnection(h.deps, {
    userId: user.id,
    sessionId: "s",
    returnPath: "/onboarding",
  });
  const { state, codeChallenge } = parseAuthorizationUrl(authorizationUrl);
  const stateHash = createHash("sha256").update(state).digest("hex");
  const row = await db.oAuthState.findUniqueOrThrow({ where: { stateHash } });
  const verifier = open(h.keyring, row.sealedCodeVerifier, `oauth_state:google_tasks:${stateHash}`);
  const code = h.google.approve({ codeChallenge, codeVerifier: verifier });
  const r = await completeGoogleTasksConnection(h.deps, {
    userId: user.id,
    sessionId: "s",
    state,
    code,
    error: null,
  });
  if (!r.ok) throw new Error(r.reason);
  const provider = () =>
    createGoogleTokenProvider(h.deps, { id: r.integrationId, userId: user.id });
  return { h, user, integrationId: r.integrationId, provider };
}

describe("Google access tokens", () => {
  it("uses a fresh token without refreshing", async () => {
    const c = await connected();
    const t = await c.provider().get();
    expect(t.accessToken).toMatch(/^fake-access-/);
    expect(c.h.google.refreshCalls).toBe(0);
  });

  it("serializes refresh: concurrent workers trigger exactly one refresh (A07)", async () => {
    const c = await connected();
    c.h.clock.advance(2 * 60 * 60 * 1000); // past expiry
    c.h.google.refreshDelayMs = 50;
    const results = await Promise.all(Array.from({ length: 6 }, () => c.provider().get()));
    expect(c.h.google.refreshCalls).toBe(1);
    expect(new Set(results.map((r) => r.accessToken)).size).toBe(1);
    const env = await db.tokenEnvelope.findUniqueOrThrow({
      where: { integrationId: c.integrationId },
    });
    expect(env.tokenVersion).toBe(2);
    expect(env.accessTokenExpiresAt!.getTime()).toBeGreaterThan(c.h.clock.now().getTime());
  });

  it("after a 401, refreshes once even if several requests were rejected with the same token", async () => {
    const c = await connected();
    const first = await c.provider().get();
    const [a, b] = await Promise.all([
      c.provider().refreshAfterRejection(first.tokenVersion),
      c.provider().refreshAfterRejection(first.tokenVersion),
    ]);
    expect(c.h.google.refreshCalls).toBe(1);
    expect(a.accessToken).toBe(b.accessToken);
    expect(a.accessToken).not.toBe(first.accessToken);
  });

  it("persists rotated refresh tokens", async () => {
    const c = await connected();
    c.h.google.rotateRefreshTokenOnRefresh = true;
    const read = async () => {
      const env = await db.tokenEnvelope.findUniqueOrThrow({
        where: { integrationId: c.integrationId },
      });
      return JSON.parse(open(c.h.keyring, env.sealedPayload, tokenAad(c.user.id, c.integrationId)))
        .refreshToken as string;
    };
    const before = await read();
    await c.provider().refreshAfterRejection(1);
    const after = await read();
    expect(after).not.toBe(before);
    // The rotated token works for the next refresh; the old one would not.
    await c.provider().refreshAfterRejection(2);
    expect(c.h.google.refreshCalls).toBe(2);
  });

  it("on invalid_grant: erases credentials, marks reconnect, and stops (A07 terminal failure)", async () => {
    const c = await connected();
    c.h.google.refreshFailure = "invalid_grant";
    await expect(c.provider().refreshAfterRejection(1)).rejects.toMatchObject({
      kind: "auth",
      code: "invalid_grant",
    });
    expect(await db.tokenEnvelope.count({ where: { integrationId: c.integrationId } })).toBe(0);
    const integration = await db.integration.findUniqueOrThrow({ where: { id: c.integrationId } });
    expect(integration).toMatchObject({
      status: "needs_reconnect",
      lastErrorCode: "invalid_grant",
    });
    await expect(c.provider().get()).rejects.toMatchObject({
      kind: "auth",
      code: "no_credentials",
    });
    expect(c.h.google.refreshCalls).toBe(1);
  });

  it("keeps credentials and retries later when Google's token endpoint is down", async () => {
    const c = await connected();
    c.h.google.refreshFailure = "server_error";
    await expect(c.provider().refreshAfterRejection(1)).rejects.toMatchObject({
      kind: "retryable",
    });
    expect(await db.tokenEnvelope.count({ where: { integrationId: c.integrationId } })).toBe(1);
    expect(
      (await db.integration.findUniqueOrThrow({ where: { id: c.integrationId } })).status,
    ).toBe("active");
  });
});
