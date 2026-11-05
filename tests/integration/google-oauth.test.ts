import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { open } from "@scholar/security";
import {
  completeGoogleTasksConnection,
  OAUTH_STATE_TTL_MS,
  startGoogleTasksConnection,
  tokenAad,
} from "@scholar/services";
import { createMockIntegration, createUser, resetDatabase, testDb } from "../support/db-helpers.ts";
import { googleHarness, parseAuthorizationUrl } from "../support/google-fixtures.ts";

const db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDatabase(db));

/** Google's side of consent: recover the PKCE verifier the app stored and approve. */
async function approveAtGoogle(
  h: ReturnType<typeof googleHarness>,
  authorizationUrl: string,
  scopes?: string[],
) {
  const { state, codeChallenge } = parseAuthorizationUrl(authorizationUrl);
  const stateHash = createHash("sha256").update(state).digest("hex");
  const row = await db.oAuthState.findUniqueOrThrow({ where: { stateHash } });
  const verifier = open(h.keyring, row.sealedCodeVerifier, `oauth_state:google_tasks:${stateHash}`);
  return { state, code: h.google.approve({ codeChallenge, codeVerifier: verifier, scopes }) };
}

async function connect(h: ReturnType<typeof googleHarness>, userId: string, sessionId = "sess-1") {
  const { authorizationUrl } = await startGoogleTasksConnection(h.deps, {
    userId,
    sessionId,
    returnPath: "/onboarding",
  });
  const { state, code } = await approveAtGoogle(h, authorizationUrl);
  return completeGoogleTasksConnection(h.deps, { userId, sessionId, state, code, error: null });
}

describe("Google Tasks OAuth connection", () => {
  it("connects read-only, seals tokens, and queues the first sync", async () => {
    const h = googleHarness(db);
    const user = await createUser(db, "g1@scholar.example");
    const { authorizationUrl } = await startGoogleTasksConnection(h.deps, {
      userId: user.id,
      sessionId: "sess-1",
      returnPath: "/onboarding",
    });
    const parsed = parseAuthorizationUrl(authorizationUrl);
    expect(parsed.scope).toBe("openid https://www.googleapis.com/auth/tasks.readonly");
    expect(parsed.prompt).toBe("consent");
    // Only a hash of the state is stored.
    expect(await db.oAuthState.count({ where: { stateHash: parsed.state } })).toBe(0);

    const { state, code } = await approveAtGoogle(h, authorizationUrl);
    const r = await completeGoogleTasksConnection(h.deps, {
      userId: user.id,
      sessionId: "sess-1",
      state,
      code,
      error: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const integration = await db.integration.findUniqueOrThrow({ where: { id: r.integrationId } });
    expect(integration).toMatchObject({
      mode: "live",
      status: "active",
      externalAccountId: "google:fake-google-sub-1",
    });
    expect(integration.scopes).not.toContain("https://www.googleapis.com/auth/tasks");

    const env = await db.tokenEnvelope.findUniqueOrThrow({
      where: { integrationId: r.integrationId },
    });
    const raw = JSON.stringify(env);
    expect(raw).not.toMatch(/fake-access-|fake-refresh-/);
    const payload = JSON.parse(
      open(h.keyring, env.sealedPayload, tokenAad(user.id, r.integrationId)),
    );
    expect(payload.accessToken).toMatch(/^fake-access-/);
    expect(payload.refreshToken).toMatch(/^fake-refresh-/);
    expect(env.hasRefreshToken).toBe(true);

    expect((await db.job.findUniqueOrThrow({ where: { id: r.jobId } })).status).toBe("queued");
    const audit = await db.auditEvent.findMany({ where: { userId: user.id } });
    expect(JSON.stringify(audit)).not.toMatch(/fake-access-|fake-refresh-|fake-code-/);
  });

  it("rejects missing, replayed, expired, cross-session, cross-user and cross-origin states (A02)", async () => {
    const h = googleHarness(db);
    const user = await createUser(db, "g2@scholar.example");
    const other = await createUser(db, "g2b@scholar.example");
    const start = () =>
      startGoogleTasksConnection(h.deps, {
        userId: user.id,
        sessionId: "sess-1",
        returnPath: "/settings",
      });

    expect(
      await completeGoogleTasksConnection(h.deps, {
        userId: user.id,
        sessionId: "sess-1",
        state: null,
        code: "x",
        error: null,
      }),
    ).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(
      await completeGoogleTasksConnection(h.deps, {
        userId: user.id,
        sessionId: "sess-1",
        state: "forged",
        code: "x",
        error: null,
      }),
    ).toMatchObject({ ok: false, reason: "invalid_state" });

    // Replay: the second use of a valid state fails.
    let a = await approveAtGoogle(h, (await start()).authorizationUrl);
    expect(
      (
        await completeGoogleTasksConnection(h.deps, {
          userId: user.id,
          sessionId: "sess-1",
          ...a,
          error: null,
        })
      ).ok,
    ).toBe(true);
    expect(
      await completeGoogleTasksConnection(h.deps, {
        userId: user.id,
        sessionId: "sess-1",
        ...a,
        error: null,
      }),
    ).toMatchObject({ ok: false, reason: "invalid_state" });

    // Expired.
    a = await approveAtGoogle(h, (await start()).authorizationUrl);
    h.clock.advance(OAUTH_STATE_TTL_MS + 1000);
    expect(
      await completeGoogleTasksConnection(h.deps, {
        userId: user.id,
        sessionId: "sess-1",
        ...a,
        error: null,
      }),
    ).toMatchObject({ ok: false, reason: "state_expired", returnPath: "/settings" });

    // Different session, different user, different configured origin: all rejected and consumed.
    for (const variant of [
      { userId: user.id, sessionId: "sess-OTHER", deps: h.deps },
      { userId: other.id, sessionId: "sess-1", deps: h.deps },
      {
        userId: user.id,
        sessionId: "sess-1",
        deps: { ...h.deps, appOrigin: "https://evil.example" },
      },
    ]) {
      a = await approveAtGoogle(h, (await start()).authorizationUrl);
      expect(
        await completeGoogleTasksConnection(variant.deps, {
          userId: variant.userId,
          sessionId: variant.sessionId,
          ...a,
          error: null,
        }),
      ).toMatchObject({ ok: false, reason: "state_mismatch" });
      // Consumed even on mismatch: the legitimate session cannot reuse it either.
      expect(
        await completeGoogleTasksConnection(h.deps, {
          userId: user.id,
          sessionId: "sess-1",
          ...a,
          error: null,
        }),
      ).toMatchObject({ ok: false, reason: "invalid_state" });
    }
    // No extra integrations were created by any rejected attempt.
    expect(await db.integration.count()).toBe(1);
    expect(await db.integration.count({ where: { userId: other.id } })).toBe(0);
  });

  it("records a denial without creating anything", async () => {
    const h = googleHarness(db);
    const user = await createUser(db, "g3@scholar.example");
    const { authorizationUrl } = await startGoogleTasksConnection(h.deps, {
      userId: user.id,
      sessionId: "s",
      returnPath: "/onboarding",
    });
    const { state } = parseAuthorizationUrl(authorizationUrl);
    expect(
      await completeGoogleTasksConnection(h.deps, {
        userId: user.id,
        sessionId: "s",
        state,
        code: null,
        error: "access_denied",
      }),
    ).toMatchObject({ ok: false, reason: "denied" });
    expect(await db.integration.count()).toBe(0);
    expect(h.google.calls.filter((c) => c.url.includes("/token"))).toHaveLength(0);
  });

  it("refuses and revokes a grant without the Tasks scope (granular consent)", async () => {
    const h = googleHarness(db);
    const user = await createUser(db, "g4@scholar.example");
    const { authorizationUrl } = await startGoogleTasksConnection(h.deps, {
      userId: user.id,
      sessionId: "s",
      returnPath: "/onboarding",
    });
    const a = await approveAtGoogle(h, authorizationUrl, ["openid"]);
    expect(
      await completeGoogleTasksConnection(h.deps, {
        userId: user.id,
        sessionId: "s",
        ...a,
        error: null,
      }),
    ).toMatchObject({ ok: false, reason: "scope_not_granted" });
    expect(await db.integration.count()).toBe(0);
    expect(await db.tokenEnvelope.count()).toBe(0);
    expect(h.google.revokedTokens).toHaveLength(1);
  });

  it("preserves the stored refresh token when Google omits one on reconnect", async () => {
    const h = googleHarness(db);
    const user = await createUser(db, "g5@scholar.example");
    const first = await connect(h, user.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = await db.tokenEnvelope.findUniqueOrThrow({
      where: { integrationId: first.integrationId },
    });
    const rtBefore = JSON.parse(
      open(h.keyring, before.sealedPayload, tokenAad(user.id, first.integrationId)),
    ).refreshToken;

    h.google.omitRefreshTokenOnExchange = true;
    const { authorizationUrl } = await startGoogleTasksConnection(h.deps, {
      userId: user.id,
      sessionId: "sess-1",
      returnPath: "/settings",
    });
    expect(parseAuthorizationUrl(authorizationUrl).prompt).toBeNull(); // no forced consent: we hold a refresh token
    const a = await approveAtGoogle(h, authorizationUrl);
    const second = await completeGoogleTasksConnection(h.deps, {
      userId: user.id,
      sessionId: "sess-1",
      ...a,
      error: null,
    });
    expect(second).toMatchObject({
      ok: true,
      refreshTokenPreserved: true,
      integrationId: first.integrationId,
    });
    const after = await db.tokenEnvelope.findUniqueOrThrow({
      where: { integrationId: first.integrationId },
    });
    const payload = JSON.parse(
      open(h.keyring, after.sealedPayload, tokenAad(user.id, first.integrationId)),
    );
    expect(payload.refreshToken).toBe(rtBefore);
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);
  });

  it("fails clearly when no refresh token exists anywhere", async () => {
    const h = googleHarness(db);
    const user = await createUser(db, "g6@scholar.example");
    h.google.omitRefreshTokenOnExchange = true;
    expect(await connect(h, user.id)).toMatchObject({ ok: false, reason: "missing_refresh_token" });
    expect(await db.tokenEnvelope.count()).toBe(0);
    expect(await db.integration.count()).toBe(0); // rolled back
    expect(h.google.revokedTokens).toHaveLength(1);
  });

  it("refuses a second Google account while one is connected", async () => {
    const h = googleHarness(db);
    const user = await createUser(db, "g7@scholar.example");
    expect((await connect(h, user.id)).ok).toBe(true);
    const h2 = { ...h, google: h.google };
    (h2.google as unknown as { opts: { sub: string } }).opts.sub = "another-account";
    expect(await connect(h2, user.id)).toMatchObject({ ok: false, reason: "different_account" });
    expect(await db.integration.count({ where: { mode: "live" } })).toBe(1);
  });

  it("retires mock connections and their synthetic data when a real account connects", async () => {
    const h = googleHarness(db);
    const user = await createUser(db, "g8@scholar.example");
    const mock = await createMockIntegration(db, user.id);
    const list = await db.taskList.create({
      data: { userId: user.id, integrationId: mock.id, externalId: "l", title: "Synthetic" },
    });
    await db.task.create({
      data: {
        userId: user.id,
        integrationId: mock.id,
        taskListId: list.id,
        externalId: "t",
        title: "x",
        status: "needs_action",
        versionHash: "h",
        syncedAt: new Date(),
      },
    });
    expect((await connect(h, user.id)).ok).toBe(true);
    expect((await db.integration.findUniqueOrThrow({ where: { id: mock.id } })).status).toBe(
      "disconnected",
    );
    expect(await db.task.count({ where: { integrationId: mock.id } })).toBe(0);
  });
});
