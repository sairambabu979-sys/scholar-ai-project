import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { open } from "@scholar/security";
import {
  completeGoogleTasksConnection,
  disconnectIntegrationWithRevocation,
  startGoogleTasksConnection,
} from "@scholar/services";
import { MOCK_LIST_COURSEWORK } from "@scholar/testing";
import { createGoogleTasksClientFactory } from "../../apps/worker/src/client-factory.ts";
import { runOnce } from "../../apps/worker/src/runner.ts";
import { createUser, resetDatabase, silentLogger, testDb } from "../support/db-helpers.ts";
import { googleHarness, OAUTH, parseAuthorizationUrl } from "../support/google-fixtures.ts";

const db = testDb();
afterAll(() => db.$disconnect());
beforeEach(() => resetDatabase(db));

async function connectedWorker() {
  const h = googleHarness(db);
  const user = await createUser(db, `w${Math.random()}@scholar.example`);
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
  const clientFor = createGoogleTasksClientFactory({
    integrationsMode: "live",
    clock: h.clock,
    live: { db, keyring: h.keyring, fetch: h.google.fetch, oauth: OAUTH },
  });
  const runner = { db, clock: h.clock, logger: silentLogger, workerId: "w1", clientFor };
  return { h, user, integrationId: r.integrationId, runner };
}

describe("live Google Tasks sync through the worker (fake Google)", () => {
  it("discovers lists, imports selected tasks, and never writes to Google", async () => {
    const c = await connectedWorker();
    expect(await runOnce(c.runner)).toBe("succeeded"); // initial sync queued by the callback
    await db.taskList.updateMany({
      where: { integrationId: c.integrationId, externalId: MOCK_LIST_COURSEWORK },
      data: { selected: true },
    });
    await db.job.create({
      data: {
        userId: c.user.id,
        kind: "google_tasks.sync",
        payload: { integrationId: c.integrationId, trigger: "manual" },
        runAt: c.h.clock.now(),
      },
    });
    expect(await runOnce(c.runner)).toBe("succeeded");
    expect(await db.task.count({ where: { integrationId: c.integrationId } })).toBe(12);
    const apiCalls = c.h.google.calls.filter((x) =>
      x.url.startsWith("https://tasks.googleapis.com"),
    );
    expect(apiCalls.length).toBeGreaterThan(0);
    expect(apiCalls.every((x) => x.method === "GET" && x.redirect === "error")).toBe(true);
    expect(apiCalls.every((x) => x.authorization?.startsWith("Bearer fake-access-"))).toBe(true);
  });

  it("recovers from an expired access token mid-sync with a single refresh", async () => {
    const c = await connectedWorker();
    c.h.google.expireAccessTokens();
    expect(await runOnce(c.runner)).toBe("succeeded");
    expect(c.h.google.refreshCalls).toBe(1);
  });

  it("marks the connection for reconnect when Google revoked the grant", async () => {
    const c = await connectedWorker();
    c.h.google.expireAccessTokens();
    c.h.google.refreshFailure = "invalid_grant";
    expect(await runOnce(c.runner)).toBe("failed"); // auth errors are not retried in a loop
    const integration = await db.integration.findUniqueOrThrow({ where: { id: c.integrationId } });
    expect(integration.status).toBe("needs_reconnect");
    expect(await db.tokenEnvelope.count()).toBe(0);
  });

  it("disconnect erases credentials immediately and reports revocation honestly (A26)", async () => {
    const c = await connectedWorker();
    const r = await disconnectIntegrationWithRevocation(
      { db, keyring: c.h.keyring, fetch: c.h.google.fetch, clock: c.h.clock },
      { userId: c.user.id, integrationId: c.integrationId, deleteCachedData: false },
    );
    expect(r?.revocation).toBe("revoked");
    expect(c.h.google.revokedTokens[0]).toMatch(/^fake-refresh-/);
    expect(await db.tokenEnvelope.count()).toBe(0);
    expect(await runOnce(c.runner)).toBe("idle"); // queued initial sync was cancelled

    const c2 = await connectedWorker();
    c2.h.google.revocationStatus = 400;
    const r2 = await disconnectIntegrationWithRevocation(
      { db, keyring: c2.h.keyring, fetch: c2.h.google.fetch, clock: c2.h.clock },
      { userId: c2.user.id, integrationId: c2.integrationId, deleteCachedData: true },
    );
    expect(r2?.revocation).toBe("failed");
    expect(await db.tokenEnvelope.count({ where: { integrationId: c2.integrationId } })).toBe(0);
    const audit = await db.auditEvent.findFirstOrThrow({
      where: { userId: c2.user.id, action: "integration.revocation" },
    });
    expect(audit.metadata).toEqual({ outcome: "failed" });
    const all = await db.auditEvent.findMany();
    expect(JSON.stringify(all)).not.toMatch(/fake-access-|fake-refresh-/);
  });

  it("only requests the read-only Tasks scope; no write capability exists (A03)", async () => {
    const c = await connectedWorker();
    const env = await db.tokenEnvelope.findUniqueOrThrow({
      where: { integrationId: c.integrationId },
    });
    expect(env.grantedScopes).toContain("https://www.googleapis.com/auth/tasks.readonly");
    expect(env.grantedScopes).not.toContain("https://www.googleapis.com/auth/tasks");
    expect(
      c.h.google.calls.some(
        (x) => x.method !== "GET" && x.url.startsWith("https://tasks.googleapis.com"),
      ),
    ).toBe(false);
  });
});
