/**
 * Disconnect any integration (SCHOLAR_AI_PLAN.md §4.2, §5, acceptance A26):
 * in ONE transaction — disable sync, cancel queued jobs (running jobs stop at their next
 * checkpoint), erase stored credentials, optionally delete cached data — then attempt
 * revocation at the provider and record what actually happened.
 */
import { cancelJobsForIntegration, recordAudit, type Db } from "@scholar/db";
import type { Clock } from "@scholar/domain";
import { revokeToken, type FetchLike } from "@scholar/integrations";
import type { Keyring } from "@scholar/security";
import { revokeCanvasEnvelope } from "./canvas-connection.ts";
import { openTokens } from "./token-store.ts";

export type RevocationOutcome = "revoked" | "failed" | "no_credentials" | "not_applicable";

export interface DisconnectDeps {
  db: Db;
  keyring: Keyring | null;
  /** HTTP transport per provider (Canvas must use the origin-guarded fetch). */
  fetchFor: (provider: "google_tasks" | "canvas", origin: string | null) => FetchLike;
  clock: Clock;
}

export async function disconnectIntegrationWithRevocation(
  deps: DisconnectDeps,
  input: { userId: string; integrationId: string; deleteCachedData: boolean; requestId?: string },
): Promise<{
  id: string;
  revocation: RevocationOutcome;
  jobs: { cancelled: number; signalled: number };
} | null> {
  const now = deps.clock.now();
  const result = await deps.db.$transaction(async (tx) => {
    const integration = await tx.integration.findFirst({
      where: { id: input.integrationId, userId: input.userId },
      select: { id: true, mode: true, provider: true, baseUrl: true },
    });
    if (!integration) return null;
    await tx.integration.update({
      where: { id: integration.id },
      data: { status: "disconnected", disconnectedAt: now },
    });
    const jobs = await cancelJobsForIntegration(tx, input.userId, integration.id, now);
    const envelope = await tx.tokenEnvelope.findUnique({
      where: { integrationId: integration.id },
      select: { sealedPayload: true },
    });
    if (envelope) await tx.tokenEnvelope.delete({ where: { integrationId: integration.id } });
    if (input.deleteCachedData) {
      const scope = { userId: input.userId, integrationId: integration.id };
      await tx.task.deleteMany({ where: scope });
      await tx.taskList.deleteMany({ where: scope });
      await tx.syncCursor.deleteMany({ where: scope });
      await tx.taskLink.deleteMany({
        where: { userId: input.userId, assignment: { integrationId: integration.id } },
      });
      await tx.assignment.deleteMany({ where: scope });
      await tx.course.deleteMany({ where: scope });
    }
    await recordAudit(tx, {
      userId: input.userId,
      actor: "user",
      action: "integration.disconnected",
      targetType: "integration",
      targetId: integration.id,
      metadata: {
        provider: integration.provider,
        deleteCachedData: input.deleteCachedData,
        credentialsErased: Boolean(envelope),
        ...jobs,
      },
      requestId: input.requestId,
    });
    return { integration, envelope, jobs };
  });
  if (!result) return null;

  const { integration, envelope } = result;
  let revocation: RevocationOutcome;
  if (integration.mode === "mock") revocation = "not_applicable";
  else if (!envelope) revocation = "no_credentials";
  else if (!deps.keyring) revocation = "failed";
  else if (integration.provider === "canvas") {
    revocation = integration.baseUrl
      ? await revokeCanvasEnvelope({
          keyring: deps.keyring,
          fetch: deps.fetchFor("canvas", integration.baseUrl),
          origin: integration.baseUrl,
          userId: input.userId,
          integrationId: integration.id,
          sealedPayload: envelope.sealedPayload,
        })
      : "failed";
  } else {
    try {
      const t = openTokens(deps.keyring, input.userId, integration.id, envelope.sealedPayload);
      revocation = await revokeToken({
        fetch: deps.fetchFor("google_tasks", null),
        token: t.refreshToken ?? t.accessToken,
      });
    } catch {
      revocation = "failed";
    }
  }
  await recordAudit(deps.db, {
    userId: input.userId,
    actor: "system",
    action: "integration.revocation",
    targetType: "integration",
    targetId: integration.id,
    metadata: { outcome: revocation },
    requestId: input.requestId,
  });
  return { id: integration.id, revocation, jobs: result.jobs };
}
