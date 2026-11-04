"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, waitForJob } from "./api-client";

export function SyncButton({ integrationId }: { integrationId: string }) {
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sync() {
    setBusy(true);
    setStatus("Sync queued…");
    try {
      const r = await apiFetch<{ jobId: string; deduplicated: boolean }>(
        `/integrations/${integrationId}/sync`,
        { method: "POST", body: {} },
      );
      if (r.deduplicated) setStatus("A sync is already in progress…");
      const outcome = await waitForJob(r.jobId);
      setStatus(outcome === "succeeded" ? "Synced" : `Sync ${outcome}`);
      router.refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="row">
      <button type="button" onClick={sync} disabled={busy}>
        Sync now
      </button>
      {status ? (
        <span role="status" className="small">
          {status}
        </span>
      ) : null}
    </span>
  );
}
