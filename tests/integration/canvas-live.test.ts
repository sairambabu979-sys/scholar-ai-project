import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { open } from "@scholar/security";
import {
  completeCanvasConnection,
  disconnectIntegrationWithRevocation,
  startCanvasConnection,
  tokenAad,
} from "@scholar/services";
import { runCanvasSync } from "../../apps/worker/src/handlers/canvas-sync.ts";
import { createUser, resetDatabase, silentLogger, testDb } from "../support/db-helpers.ts";
import { liveCanvas } from "../support/canvas-fixtures.ts";

const db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDatabase(db));

async function connected() {
  const h = liveCanvas(db);
  const user = await createUser(db, `l${Math.random()}@scholar.example`);
  const { authorizationUrl } = await startCanvasConnection(h.deps, {
    userId: user.id,
    sessionId: "s",
    returnPath: "/onboarding",
  });
  const u = new URL(authorizationUrl);
  const state = u.searchParams.get("state")!;
  const stateHash = createHash("sha256").update(state).digest("hex");
  const row = await db.oAuthState.findUniqueOrThrow({ where: { stateHash } });
  const verifier = open(h.keyring, row.sealedCodeVerifier, `oauth_state:canvas:${stateHash}`);
  const code = h.fake.approve(verifier);
  const r = await completeCanvasConnection(h.deps, {
    userId: user.id,
    sessionId: "s",
    state,
    code,
    error: null,
  });
  return { h, user, r, authorizationUrl: u, state, code };
}

describe("Canvas OAuth on the configured institution host (fake Canvas)", () => {
  it("authorizes on the configured origin with read-only scopes and seals tokens", async () => {
    const { h, user, r, authorizationUrl } = await connected();
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://canvas.school.example/login/oauth2/auth",
    );
    expect(
      authorizationUrl.searchParams
        .get("scope")!
        .split(" ")
        .every((s) => s.startsWith("url:GET|")),
    ).toBe(true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const integration = await db.integration.findUniqueOrThrow({ where: { id: r.integrationId } });
    expect(integration).toMatchObject({
      provider: "canvas",
      mode: "live",
      baseUrl: "https://canvas.school.example",
      externalAccountId: "canvas:https://canvas.school.example:4242",
    });
    const env = await db.tokenEnvelope.findUniqueOrThrow({
      where: { integrationId: r.integrationId },
    });
    expect(JSON.stringify(env)).not.toMatch(/canvas-access-|canvas-refresh-/);
    const payload = JSON.parse(
      open(h.keyring, env.sealedPayload, tokenAad(user.id, r.integrationId, "canvas")),
    );
    expect(payload.refreshToken).toMatch(/^canvas-refresh-/);
    // A Google-bound AAD cannot open a Canvas envelope.
    expect(() =>
      open(h.keyring, env.sealedPayload, tokenAad(user.id, r.integrationId, "google_tasks")),
    ).toThrow();
  });

  it("rejects replayed states and states issued for another provider (A02)", async () => {
    const { h, user, state, code } = await connected();
    expect(
      await completeCanvasConnection(h.deps, {
        userId: user.id,
        sessionId: "s",
        state,
        code,
        error: null,
      }),
    ).toMatchObject({ ok: false, reason: "invalid_state" });
  });

  it("syncs through the live client: Link pagination, own submissions only, nothing written to Canvas", async () => {
    const { h, user, r } = await connected();
    if (!r.ok) throw new Error(r.reason);
    const s = await runCanvasSync(
      { db, clock: h.clock, logger: silentLogger, clientFor: h.clientFor },
      { userId: user.id, integrationId: r.integrationId, trigger: "initial" },
    );
    expect(s).toMatchObject({ status: "succeeded", courses: 4, assignmentsFetched: 9 });
    const api = h.fake.calls.filter((c) => c.url.includes("/api/v1/"));
    expect(api.every((c) => c.method === "GET" && c.redirect === "error")).toBe(true);
    expect(api.some((c) => c.url.includes("page=2"))).toBe(true);
    expect(api.every((c) => !c.url.includes("read_status"))).toBe(true);
  });

  it("refuses a foreign pagination link and commits nothing from that scan (A16)", async () => {
    const { h, user, r } = await connected();
    if (!r.ok) throw new Error(r.reason);
    h.fake.foreignNextLink = true;
    await expect(
      runCanvasSync(
        { db, clock: h.clock, logger: silentLogger, clientFor: h.clientFor },
        { userId: user.id, integrationId: r.integrationId, trigger: "manual" },
      ),
    ).rejects.toMatchObject({ code: "canvas_foreign_url_refused" });
    expect(
      h.fake.calls.every((c) => new URL(c.url).origin === "https://canvas.school.example"),
    ).toBe(true);
    expect(await db.course.count()).toBe(0);
  });

  it("records 'unavailable' when the developer key ignores include[]=submission", async () => {
    const { h, user, r } = await connected();
    if (!r.ok) throw new Error(r.reason);
    h.fake.ignoreSubmissionInclude = true;
    await runCanvasSync(
      { db, clock: h.clock, logger: silentLogger, clientFor: h.clientFor },
      { userId: user.id, integrationId: r.integrationId, trigger: "manual" },
    );
    const statuses = await db.submissionSnapshot.findMany({ select: { status: true } });
    expect(statuses.length).toBe(9);
    expect(statuses.every((x) => x.status === "unavailable")).toBe(true);
  });

  it("refreshes an expired token once and continues", async () => {
    const { h, user, r } = await connected();
    if (!r.ok) throw new Error(r.reason);
    h.fake.expireAccessTokens();
    const s = await runCanvasSync(
      { db, clock: h.clock, logger: silentLogger, clientFor: h.clientFor },
      { userId: user.id, integrationId: r.integrationId, trigger: "manual" },
    );
    expect(s.status).toBe("succeeded");
    expect(
      h.fake.calls.filter((c) => c.url.endsWith("/login/oauth2/token") && c.method === "POST"),
    ).toHaveLength(2); // exchange + one refresh
  });

  it("disconnect erases credentials and revokes at the configured Canvas host", async () => {
    const { h, user, r } = await connected();
    if (!r.ok) throw new Error(r.reason);
    const out = await disconnectIntegrationWithRevocation(
      {
        db,
        keyring: h.keyring,
        clock: h.clock,
        fetchFor: (provider, origin) =>
          provider === "canvas" && origin === h.oauth.origin
            ? h.fake.fetch
            : () => Promise.reject(new Error("wrong host")),
      },
      { userId: user.id, integrationId: r.integrationId, deleteCachedData: true },
    );
    expect(out?.revocation).toBe("revoked");
    expect(h.fake.revoked[0]).toMatch(/^canvas-access-/);
    expect(await db.tokenEnvelope.count()).toBe(0);
  });
});
