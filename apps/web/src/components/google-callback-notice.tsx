/** Explains the outcome of the Google consent round trip (`?google=…&reason=…`). */
const REASONS: Record<string, string> = {
  denied: "You declined access in Google. Nothing was connected.",
  scope_not_granted:
    "Google did not grant read access to Tasks (the Tasks box may have been unticked). Nothing was stored; try again and allow Tasks access.",
  invalid_state: "That connection link was already used or is unknown. Start the connection again.",
  state_mismatch: "That connection was started in a different session. Start it again from here.",
  state_expired: "The connection took too long (over 10 minutes). Start it again.",
  token_exchange_failed:
    "Google did not accept the connection. Check the OAuth client settings and try again.",
  identity_missing: "Google did not confirm which account was connected. Nothing was stored.",
  different_account:
    "Another Google account is already connected. Disconnect it in Settings before connecting a different one.",
  missing_refresh_token:
    "Google did not provide long-lived access, so background sync would stop. Remove Scholar AI's access in your Google Account, then connect again.",
  not_configured: "Google Tasks connection is not configured on this server.",
  provider_error: "Google reported an error during consent. Try again.",
  invalid_request: "The response from Google was incomplete. Try again.",
};

export function GoogleCallbackNotice({ google, reason }: { google?: string; reason?: string }) {
  if (google === "connected") {
    return (
      <p className="notice" role="status" data-testid="google-callback">
        Google Tasks connected (read-only). The first sync is running; choose which lists to import
        below.
      </p>
    );
  }
  if (google === "error") {
    return (
      <p className="notice error" role="alert" data-testid="google-callback">
        {REASONS[reason ?? ""] ?? "The Google connection did not complete. Try again."}
      </p>
    );
  }
  return null;
}

const DISCONNECTED: Record<string, string> = {
  revoked:
    "Disconnected. Stored credentials were erased and Google confirmed the access was revoked.",
  failed:
    "Disconnected and stored credentials erased, but Google did not confirm revocation. To be sure, remove Scholar AI under Third-party access in your Google Account.",
  no_credentials: "Disconnected. No stored credentials remained to revoke.",
  not_applicable: "Disconnected. (Mock connection: nothing was stored at Google.)",
};

export function DisconnectNotice({ outcome }: { outcome?: string }) {
  if (!outcome || !DISCONNECTED[outcome]) return null;
  return (
    <p
      className={outcome === "failed" ? "notice error" : "notice"}
      role="status"
      data-testid="disconnect-notice"
    >
      {DISCONNECTED[outcome]}
    </p>
  );
}
