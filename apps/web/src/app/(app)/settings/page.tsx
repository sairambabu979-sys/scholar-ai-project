import { requirePageUser } from "@/lib/session";
import { loadAccountState } from "@/lib/account-state";
import { TimezoneForm } from "@/components/timezone-form";
import { ListSelectionForm } from "@/components/list-selection-form";
import { DisconnectButton } from "@/components/disconnect-button";
import { ConnectTasksButton } from "@/components/connect-tasks-button";
import { SyncStatus } from "@/components/sync-status";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await requirePageUser();
  const { env, profile, activeGoogle } = await loadAccountState(user.id);
  return (
    <>
      <h1>Settings</h1>
      <section className="card" aria-labelledby="profile-heading">
        <h2 id="profile-heading">Profile</h2>
        <p className="small">
          {profile.name} · {profile.email}
        </p>
        <TimezoneForm current={profile.timezone} />
      </section>
      <section className="card" aria-labelledby="conn-heading">
        <h2 id="conn-heading">Google Tasks connection</h2>
        {activeGoogle ? (
          <div className="stack">
            <SyncStatus
              timezone={profile.timezone}
              mode={activeGoogle.mode}
              status={activeGoogle.status}
              freshness={activeGoogle.freshness}
              lastAttemptAt={activeGoogle.lastAttemptAt}
              lastSuccessAt={activeGoogle.lastSuccessAt}
              lastErrorCode={activeGoogle.lastErrorCode}
            />
            {activeGoogle.taskLists.length > 0 ? (
              <ListSelectionForm integrationId={activeGoogle.id} lists={activeGoogle.taskLists} />
            ) : null}
            <DisconnectButton integrationId={activeGoogle.id} />
          </div>
        ) : env.integrationsMode === "mock" ? (
          <ConnectTasksButton mock />
        ) : (
          <p className="notice">Live Google Tasks connection arrives in Phase 2.</p>
        )}
      </section>
      <section className="card" aria-labelledby="data-heading">
        <h2 id="data-heading">Your data</h2>
        <p className="small muted">
          Account export and deletion arrive with production readiness (Phase 7). Disconnecting
          above can delete imported tasks immediately.
        </p>
      </section>
    </>
  );
}
