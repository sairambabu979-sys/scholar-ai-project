"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, waitForJob } from "./api-client";

export function ConnectTasksButton({ mock }: { mock: boolean }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect() {
    setBusy(true);
    setStatus("Connecting…");
    try {
      const r = await apiFetch<{ jobId: string }>("/integrations/google/connect", {
        method: "POST",
        body: {},
      });
      setStatus("Discovering task lists…");
      const outcome = await waitForJob(r.jobId);
      setStatus(
        outcome === "succeeded" ? "Task lists found. Choose which to import." : `Sync ${outcome}`,
      );
      router.refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not connect");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="row">
      <button type="button" onClick={connect} disabled={busy}>
        {mock ? "Connect mock Google Tasks (synthetic data)" : "Connect Google Tasks"}
      </button>
      {status ? (
        <span role="status" className="small">
          {status}
        </span>
      ) : null}
    </div>
  );
}
