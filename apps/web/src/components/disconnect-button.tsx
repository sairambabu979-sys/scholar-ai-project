"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "./api-client";

export function DisconnectButton({ integrationId }: { integrationId: string }) {
  const router = useRouter();
  const [deleteCached, setDeleteCached] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function disconnect() {
    try {
      const r = await apiFetch<{ revocation: string }>(`/integrations/${integrationId}`, {
        method: "DELETE",
        body: { deleteCachedData: deleteCached },
      });
      // The button disappears once disconnected; carry the outcome to a page-level notice.
      router.push(`/settings?disconnected=${encodeURIComponent(r.revocation)}`);
      router.refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not disconnect");
    }
  }

  if (!confirming) {
    return (
      <button type="button" className="danger" onClick={() => setConfirming(true)}>
        Disconnect…
      </button>
    );
  }
  return (
    <div className="stack" role="group" aria-label="Confirm disconnect">
      <p className="small">Disconnecting stops all syncing immediately and cancels queued work.</p>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={deleteCached}
          onChange={(e) => setDeleteCached(e.target.checked)}
        />
        Also delete imported tasks and lists from Scholar AI
      </label>
      <div className="row">
        <button type="button" className="danger" onClick={disconnect}>
          Confirm disconnect
        </button>
        <button type="button" className="secondary" onClick={() => setConfirming(false)}>
          Cancel
        </button>
        {status ? <span role="status">{status}</span> : null}
      </div>
    </div>
  );
}
