import type { loadAccountState } from "@/lib/account-state";
import { ConnectTasksButton } from "./connect-tasks-button";
import { DisconnectButton } from "./disconnect-button";
import { ListSelectionForm } from "./list-selection-form";
import { SyncStatus } from "./sync-status";

type AccountState = Awaited<ReturnType<typeof loadAccountState>>;

/** Google Tasks connection state, shared by onboarding and settings. */
export function GoogleTasksConnection(props: {
  state: AccountState;
  returnTo: "/onboarding" | "/settings";
  showDisconnect: boolean;
}) {
  const { env, profile, activeGoogle } = props.state;
  const mockMode = env.integrationsMode === "mock";

  const connectHelp = mockMode ? (
    <p className="small">
      Mock mode connects a labelled fixture adapter with synthetic coursework. It never contacts
      Google.
    </p>
  ) : (
    <div className="small stack">
      <p>
        Google will ask you to allow <strong>read-only</strong> access to your tasks (plus your
        account identity, so Scholar AI knows which account is connected). Scholar AI cannot change,
        complete or delete tasks with this permission.
      </p>
      <p className="muted">
        While the Google Cloud app is in <em>Testing</em> status, Google may expire this access
        after about 7 days; Scholar AI will then ask you to reconnect.
      </p>
    </div>
  );

  if (!activeGoogle || (activeGoogle.mode === "mock" && !mockMode)) {
    return (
      <div className="stack">
        {activeGoogle ? (
          <p className="notice">
            A mock connection from an earlier setup is still listed. Connecting your real Google
            account retires it and deletes its synthetic tasks.
          </p>
        ) : null}
        {connectHelp}
        <ConnectTasksButton mock={mockMode} returnTo={props.returnTo} />
      </div>
    );
  }

  const g = activeGoogle;
  return (
    <div className="stack">
      <SyncStatus
        timezone={profile.timezone}
        mode={g.mode}
        status={g.status}
        freshness={g.freshness}
        lastAttemptAt={g.lastAttemptAt}
        lastSuccessAt={g.lastSuccessAt}
        lastErrorCode={g.lastErrorCode}
        activeJobStatus={g.activeJob?.status ?? null}
      />
      <p className="small">
        Granted capability:{" "}
        <strong>
          {g.mode === "mock" ? "read synthetic fixtures (mock)" : "read-only task access"}
        </strong>
        . Scholar AI cannot change your tasks.
      </p>
      {g.status === "needs_reconnect" && g.mode === "live" ? (
        <ConnectTasksButton mock={false} returnTo={props.returnTo} label="Reconnect Google Tasks" />
      ) : null}
      {g.taskLists.length > 0 ? (
        <ListSelectionForm integrationId={g.id} lists={g.taskLists} />
      ) : g.status === "active" ? (
        <p className="muted small">Waiting for the first sync to discover your lists…</p>
      ) : null}
      {props.showDisconnect ? <DisconnectButton integrationId={g.id} /> : null}
    </div>
  );
}
