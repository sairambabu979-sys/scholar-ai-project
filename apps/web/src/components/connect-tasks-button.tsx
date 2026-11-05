"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, waitForJob } from "./api-client";

type ConnectResult =
  | { kind: "connected"; integrationId: string; jobId: string }
  | { kind: "redirect"; authorizationUrl: string };

const GOOGLE_AUTH_PREFIX = "https://accounts.google.com/";

export function ConnectTasksButton(props: {
  mock: boolean;
  returnTo?: "/onboarding" | "/settings";
  label?: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    setStatus("Connecting…");
    try {
      const r = await apiFetch<ConnectResult>("/integrations/google/connect", {
        method: "POST",
        body: { returnTo: props.returnTo ?? "/onboarding" },
      });
      if (r.kind === "redirect") {
        // Only ever navigate to Google's consent page.
        if (!r.authorizationUrl.startsWith(GOOGLE_AUTH_PREFIX))
          throw new Error("Unexpected authorization URL");
        setStatus("Opening Google…");
        window.location.assign(r.authorizationUrl);
        return;
      }
      setStatus("Discovering task lists…");
      const outcome = await waitForJob(r.jobId);
      setStatus(
        outcome === "succeeded" ? "Task lists found. Choose which to import." : `Sync ${outcome}`,
      );
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
        {props.label ??
          (props.mock
            ? "Connect mock Google Tasks (synthetic data)"
            : "Connect Google Tasks (read-only)")}
      </button>
      {status ? (
        <span role="status" className="small">
          {status}
        </span>
      ) : null}
    </div>
  );
}
