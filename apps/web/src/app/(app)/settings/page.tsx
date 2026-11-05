import { requirePageUser } from "@/lib/session";
import { loadAccountState } from "@/lib/account-state";
import { TimezoneForm } from "@/components/timezone-form";
import { GoogleTasksConnection } from "@/components/google-tasks-connection";
import { CanvasConnection } from "@/components/canvas-connection";
import { DisconnectNotice, GoogleCallbackNotice } from "@/components/google-callback-notice";

export const dynamic = "force-dynamic";

export default async function SettingsPage(props: {
  searchParams: Promise<{
    google?: string;
    canvas?: string;
    reason?: string;
    disconnected?: string;
  }>;
}) {
  const user = await requirePageUser();
  const state = await loadAccountState(user.id);
  const { google, canvas, reason, disconnected } = await props.searchParams;
  return (
    <>
      <h1>Settings</h1>
      <GoogleCallbackNotice google={google} canvas={canvas} reason={reason} />
      <DisconnectNotice outcome={disconnected} />
      <section className="card" aria-labelledby="profile-heading">
        <h2 id="profile-heading">Profile</h2>
        <p className="small">
          {state.profile.name} · {state.profile.email}
        </p>
        <TimezoneForm current={state.profile.timezone} />
      </section>
      <section className="card" aria-labelledby="conn-heading">
        <h2 id="conn-heading">Google Tasks connection</h2>
        <GoogleTasksConnection state={state} returnTo="/settings" showDisconnect />
      </section>
      <section className="card" aria-labelledby="canvas-settings-heading">
        <h2 id="canvas-settings-heading">Canvas connection</h2>
        <CanvasConnection state={state} returnTo="/settings" showDisconnect />
      </section>
      <section className="card" aria-labelledby="data-heading">
        <h2 id="data-heading">Your data</h2>
        <p className="small muted">
          Account export and deletion arrive with production readiness (Phase 7). Disconnecting
          above erases stored Google credentials immediately, asks Google to revoke them, and can
          delete imported tasks.
        </p>
      </section>
    </>
  );
}
