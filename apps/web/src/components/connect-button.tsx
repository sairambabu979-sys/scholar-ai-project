"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, waitForJob } from "./api-client";

type ConnectResult =
  | { kind: "connected"; integrationId: string; jobId: string }
  | { kind: "redirect"; authorizationUrl: string };

/**
 * Starts a provider connection. Mock connections sync immediately; live ones navigate to the
 * provider's consent page — and only if the URL is on the expected provider origin.
 */
export function ConnectButton(props: {
  endpoint: "/integrations/google/connect" | "/integrations/canvas/connect";
  allowedRedirectOrigin: string | null;
  returnTo: "/onboarding" | "/settings";
  label: string;
  syncedMessage: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    setStatus("Connecting…");
    try {
      const r = await apiFetch<ConnectResult>(props.endpoint, {
        method: "POST",
        body: { returnTo: props.returnTo },
      });
      if (r.kind === "redirect") {
        if (
          !props.allowedRedirectOrigin ||
          new URL(r.authorizationUrl).origin !== props.allowedRedirectOrigin
        ) {
          throw new Error("Unexpected authorization URL");
        }
        setStatus("Opening sign-in…");
        window.location.assign(r.authorizationUrl);
        return;
      }
      setStatus("Syncing…");
      const outcome = await waitForJob(r.jobId);
      setStatus(outcome === "succeeded" ? props.syncedMessage : `Sync ${outcome}`);
      router.refresh();
      setBusy(false);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not connect");
      setBusy(false);
    }
  }

  return (
    <div className="row">
      <button type="button" onClick={connect} disabled={busy}>
        {props.label}
      </button>
      {status ? (
        <span role="status" className="small">
          {status}
        </span>
      ) : null}
    </div>
  );
}
