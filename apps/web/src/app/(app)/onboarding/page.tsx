import { requirePageUser } from "@/lib/session";
import { loadAccountState } from "@/lib/account-state";
import { TimezoneForm } from "@/components/timezone-form";
import { GoogleTasksConnection } from "@/components/google-tasks-connection";
import { GoogleCallbackNotice } from "@/components/google-callback-notice";
import { FinishOnboardingButton } from "@/components/finish-onboarding-button";

export const dynamic = "force-dynamic";

export default async function OnboardingPage(props: {
  searchParams: Promise<{ google?: string; reason?: string }>;
}) {
  const user = await requirePageUser();
  const state = await loadAccountState(user.id);
  const { profile, activeGoogle } = state;
  const { google, reason } = await props.searchParams;
  const hasSelection = Boolean(activeGoogle?.taskLists.some((l) => l.selected));

  return (
    <>
      <h1>Set up Scholar AI</h1>
      <GoogleCallbackNotice google={google} reason={reason} />
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
            <GoogleTasksConnection state={state} returnTo="/onboarding" showDisconnect={false} />
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
