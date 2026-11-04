import { requirePageUser } from "@/lib/session";
import { loadAccountState } from "@/lib/account-state";
import { TimezoneForm } from "@/components/timezone-form";
import { ConnectTasksButton } from "@/components/connect-tasks-button";
import { ListSelectionForm } from "@/components/list-selection-form";
import { SyncStatus } from "@/components/sync-status";
import { FinishOnboardingButton } from "@/components/finish-onboarding-button";

export const dynamic = "force-dynamic";

export default async function OnboardingPage() {
  const user = await requirePageUser();
  const { env, profile, activeGoogle } = await loadAccountState(user.id);
  const mock = env.integrationsMode === "mock";
  const hasSelection = Boolean(activeGoogle?.taskLists.some((l) => l.selected));

  return (
    <>
      <h1>Set up Scholar AI</h1>
      <ol className="steps stack">
        <li>
          <section className="card" aria-labelledby="tz-heading">
            <h2 id="tz-heading">Your timezone</h2>
            <p className="small muted">
              Used to decide what is due “today”. Google Tasks due dates are calendar dates and are
              never shifted by timezone.
            </p>
            <TimezoneForm current={profile.timezone} />
          </section>
        </li>
        <li>
          <section className="card" aria-labelledby="gt-heading">
            <h2 id="gt-heading">Connect Google Tasks</h2>
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
                  activeJobStatus={activeGoogle.activeJob?.status ?? null}
                />
                <p className="small">
                  Granted capability:{" "}
                  <strong>
                    {mock ? "read synthetic fixtures (mock)" : "read-only task access"}
                  </strong>
                  . Scholar AI cannot change your tasks.
                </p>
                {activeGoogle.taskLists.length > 0 ? (
                  <ListSelectionForm
                    integrationId={activeGoogle.id}
                    lists={activeGoogle.taskLists}
                  />
                ) : (
                  <p className="muted small">Waiting for the first sync to discover your lists…</p>
                )}
              </div>
            ) : mock ? (
              <div className="stack">
                <p className="small">
                  Mock mode connects a labelled fixture adapter with synthetic coursework. It never
                  contacts Google.
                </p>
                <ConnectTasksButton mock />
              </div>
            ) : (
              <p className="notice">
                Live Google Tasks connection is not implemented in this build (Phase 2). Nothing has
                been connected.
              </p>
            )}
          </section>
        </li>
        <li>
          <section className="card" aria-labelledby="canvas-heading">
            <h2 id="canvas-heading">Canvas</h2>
            <p className="notice" data-testid="canvas-unavailable">
              Canvas connection unavailable. Connecting Canvas requires your institution to approve
              a developer key; that has not been established. Manual assignment entry arrives in
              Phase 3. Google Tasks and study features do not depend on it.
            </p>
          </section>
        </li>
        <li>
          <section className="card" aria-labelledby="autonomy-heading">
            <h2 id="autonomy-heading">What Scholar AI may do on its own</h2>
            <ul className="small">
              <li>
                Read your selected task lists in the background (every ~15 minutes, or when you
                press Sync).
              </li>
              <li>
                AI assistance and any change to Google Tasks always need your explicit, per-action
                approval.
              </li>
              <li>
                Scholar AI never submits Canvas work, takes quizzes, or marks tasks complete by
                itself.
              </li>
              <li>
                No coursework is sent to an AI provider in this build; you will be asked first when
                that feature exists.
              </li>
            </ul>
          </section>
        </li>
      </ol>
      <FinishOnboardingButton disabled={!hasSelection} />
      {!hasSelection ? (
        <p className="small muted">Select at least one task list to continue.</p>
      ) : null}
    </>
  );
}
