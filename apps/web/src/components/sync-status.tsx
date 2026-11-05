import { formatInstant } from "@scholar/domain";

const FRESHNESS_TEXT: Record<string, string> = {
  never: "Not synced yet",
  fresh: "Up to date",
  stale: "Stale — last successful sync is older than expected",
  failing: "Last sync attempt failed — showing last known data",
};

/** Plain-language explanations for safe error codes recorded by the worker. */
const ERROR_HELP: Record<string, string> = {
  google_tasks_api_disabled:
    "The Google Tasks API is not enabled in your Google Cloud project. Enable it, then sync again.",
  invalid_grant:
    "Google no longer accepts the stored permission (it may have expired or been revoked). Reconnect.",
  google_insufficient_scope: "The stored permission does not include Tasks read access. Reconnect.",
  no_credentials: "No stored permission was found. Reconnect.",
  google_rate_limited: "Google is rate limiting requests; Scholar AI will retry automatically.",
  mock_integration_in_live_mode:
    "This is a mock connection, which cannot run in live mode. Connect Google Tasks instead.",
  live_integration_in_mock_mode:
    "This server is in mock mode and does not contact Google or Canvas.",
  canvas_forbidden_scope_or_permission:
    "Canvas refused the request. The developer key may not include a needed read scope, or access changed.",
  canvas_throttled: "Canvas is rate limiting requests; Scholar AI will retry automatically.",
  canvas_foreign_url_refused:
    "Canvas returned a link to another host, which Scholar AI refuses to follow.",
  canvas_url_policy: "The Canvas host resolved to a disallowed network address; nothing was sent.",
  canvas_origin_mismatch:
    "This Canvas connection is for a different school address than the one configured. Reconnect.",
};

export function SyncStatus(props: {
  timezone: string;
  mode: "mock" | "live";
  provider?: "google_tasks" | "canvas";
  status: string;
  freshness: string;
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  lastErrorCode: string | null;
  activeJobStatus?: string | null;
}) {
  const fmt = (d: Date | null) => (d ? formatInstant(d, props.timezone) : "never");
  const warn =
    props.freshness === "stale" || props.freshness === "failing" || props.status !== "active";
  const help =
    props.lastErrorCode && (props.freshness === "failing" || props.status !== "active")
      ? ERROR_HELP[props.lastErrorCode]
      : undefined;
  return (
    <div
      className="stack small"
      data-testid={props.provider === "canvas" ? "sync-status-canvas" : "sync-status"}
    >
      <div className="row">
        <span className="badge">
          {props.provider === "canvas"
            ? props.mode === "mock"
              ? "Canvas (mock fixtures)"
              : "Canvas (read-only)"
            : props.mode === "mock"
              ? "Google Tasks (mock fixtures)"
              : "Google Tasks (read-only)"}
        </span>
        <span className="badge">{props.status}</span>
        {props.activeJobStatus ? <span className="badge">sync {props.activeJobStatus}</span> : null}
      </div>
      <p className={warn ? "notice" : "muted"} role={warn ? "alert" : undefined}>
        {props.status === "needs_reconnect"
          ? `Reconnect required — ${props.provider === "canvas" ? "Canvas" : "Google"} rejected the stored permission.`
          : FRESHNESS_TEXT[props.freshness]}
        {props.lastErrorCode && props.freshness === "failing"
          ? ` (code: ${props.lastErrorCode})`
          : ""}
      </p>
      {help ? <p className="small">{help}</p> : null}
      <p className="muted">
        Last successful sync: {fmt(props.lastSuccessAt)} · Last attempt: {fmt(props.lastAttemptAt)}
      </p>
    </div>
  );
}
