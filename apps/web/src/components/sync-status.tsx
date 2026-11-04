import { formatInstant } from "@scholar/domain";

const FRESHNESS_TEXT: Record<string, string> = {
  never: "Not synced yet",
  fresh: "Up to date",
  stale: "Stale — last successful sync is older than expected",
  failing: "Last sync attempt failed — showing last known data",
};

export function SyncStatus(props: {
  timezone: string;
  mode: "mock" | "live";
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
  return (
    <div className="stack small" data-testid="sync-status">
      <div className="row">
        <span className="badge">
          {props.mode === "mock" ? "Google Tasks (mock fixtures)" : "Google Tasks"}
        </span>
        <span className="badge">{props.status}</span>
        {props.activeJobStatus ? <span className="badge">sync {props.activeJobStatus}</span> : null}
      </div>
      <p className={warn ? "notice" : "muted"} role={warn ? "alert" : undefined}>
        {props.status === "needs_reconnect"
          ? "Reconnect required — the stored permission was rejected."
          : FRESHNESS_TEXT[props.freshness]}
        {props.lastErrorCode && props.freshness === "failing"
          ? ` (code: ${props.lastErrorCode})`
          : ""}
      </p>
      <p className="muted">
        Last successful sync: {fmt(props.lastSuccessAt)} · Last attempt: {fmt(props.lastAttemptAt)}
      </p>
    </div>
  );
}
