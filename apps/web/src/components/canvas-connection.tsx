import type { loadAccountState } from "@/lib/account-state";
import { ConnectButton } from "./connect-button";
import { DisconnectButton } from "./disconnect-button";
import { SyncButton } from "./sync-button";
import { SyncStatus } from "./sync-status";

type AccountState = Awaited<ReturnType<typeof loadAccountState>>;

/** Canvas connection state, or an honest "unavailable" with the manual fallback. */
export function CanvasConnection(props: {
  state: AccountState;
  returnTo: "/onboarding" | "/settings";
  showDisconnect: boolean;
}) {
  const { profile, activeCanvas, canvasAvailability, canvasOrigin, canvasCourseCount } =
    props.state;
  const unavailable = (
    <p className="notice" data-testid="canvas-unavailable">
      Canvas connection unavailable. Connecting Canvas requires your institution to approve a
      developer key, and none is configured. You can still add assignment details by hand on any
      task; Google Tasks and study features do not depend on Canvas.
    </p>
  );

  if (activeCanvas && !(activeCanvas.mode === "mock" && canvasAvailability !== "mock")) {
    return (
      <div className="stack" data-testid="canvas-connected">
        <SyncStatus
          timezone={profile.timezone}
          mode={activeCanvas.mode}
          provider="canvas"
          status={activeCanvas.status}
          freshness={activeCanvas.freshness}
          lastAttemptAt={activeCanvas.lastAttemptAt}
          lastSuccessAt={activeCanvas.lastSuccessAt}
          lastErrorCode={activeCanvas.lastErrorCode}
          activeJobStatus={activeCanvas.activeJob?.status ?? null}
        />
        <p className="small">
          Granted capability:{" "}
          <strong>
            {activeCanvas.mode === "mock"
              ? "read synthetic courses (mock)"
              : "read-only courses and assignments"}
          </strong>
          . {canvasCourseCount} course{canvasCourseCount === 1 ? "" : "s"} imported. Scholar AI
          never submits work, opens quizzes or changes anything in Canvas.
        </p>
        {activeCanvas.status === "active" ? <SyncButton integrationId={activeCanvas.id} /> : null}
        {activeCanvas.status === "needs_reconnect" && canvasAvailability === "live" ? (
          <ConnectButton
            endpoint="/integrations/canvas/connect"
            allowedRedirectOrigin={canvasOrigin}
            returnTo={props.returnTo}
            label="Reconnect Canvas"
            syncedMessage="Courses imported."
          />
        ) : null}
        {props.showDisconnect ? <DisconnectButton integrationId={activeCanvas.id} /> : null}
      </div>
    );
  }
  if (canvasAvailability === "unavailable") return unavailable;
  return (
    <div className="stack">
      <p className="small">
        {canvasAvailability === "mock"
          ? "Mock mode connects a labelled synthetic Canvas with invented courses. It never contacts Canvas."
          : `Connects read-only to ${canvasOrigin}. Your school's sign-in page will ask you to authorize access to your courses and assignments.`}
      </p>
      <ConnectButton
        endpoint="/integrations/canvas/connect"
        allowedRedirectOrigin={canvasOrigin}
        returnTo={props.returnTo}
        label={
          canvasAvailability === "mock"
            ? "Connect mock Canvas (synthetic data)"
            : "Connect Canvas (read-only)"
        }
        syncedMessage="Courses imported."
      />
    </div>
  );
}
