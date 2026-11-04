import { getProfile } from "@scholar/db";
import { apiRoute, jsonData, notFound } from "@/lib/api";
import { db } from "@/lib/db";
import { serverEnv } from "@/lib/server-env";

export const dynamic = "force-dynamic";

export const GET = apiRoute({}, async ({ user, requestId }) => {
  const profile = await getProfile(db(), user.id);
  if (!profile) throw notFound();
  const env = serverEnv();
  return jsonData(
    {
      id: profile.id,
      name: profile.name,
      email: profile.email,
      timezone: profile.timezone,
      onboardingCompleted: Boolean(profile.preference.onboardingCompletedAt),
      syncEnabled: profile.preference.syncEnabled,
      consent: { aiDataUse: profile.preference.aiDataUseConsent ?? null },
      capabilities: {
        integrationsMode: env.integrationsMode,
        googleTasksRead: env.integrationsMode === "mock" ? "mock" : "unavailable",
        googleTasksWrite: "unavailable",
        canvas: "unavailable",
        aiAssistance: "unavailable",
      },
    },
    requestId,
  );
});
