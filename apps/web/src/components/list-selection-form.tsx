"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch, waitForJob } from "./api-client";

export function ListSelectionForm(props: {
  integrationId: string;
  lists: Array<{ id: string; title: string; selected: boolean; available: boolean }>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState(
    () => new Set(props.lists.filter((l) => l.selected).map((l) => l.id)),
  );
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setStatus("Saving…");
    try {
      await apiFetch("/me/preferences", {
        method: "PATCH",
        body: { selectedLists: { integrationId: props.integrationId, listIds: [...selected] } },
      });
      if (selected.size > 0) {
        setStatus("Importing tasks…");
        const r = await apiFetch<{ jobId: string }>(`/integrations/${props.integrationId}/sync`, {
          method: "POST",
          body: {},
        });
        const outcome = await waitForJob(r.jobId);
        setStatus(outcome === "succeeded" ? "Imported" : `Sync ${outcome}`);
      } else {
        setStatus("Saved — no lists selected");
      }
      router.refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save}>
      <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
        <legend className="small muted">
          Only selected lists are imported. Google grants access to all lists; this restriction is
          applied by Scholar AI.
        </legend>
        {props.lists.map((l) => (
          <label key={l.id} className="checkbox">
            <input
              type="checkbox"
              checked={selected.has(l.id)}
              disabled={!l.available}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(l.id);
                else next.delete(l.id);
                setSelected(next);
              }}
            />
            {l.title}
            {!l.available ? <span className="badge">no longer available</span> : null}
          </label>
        ))}
      </fieldset>
      <div className="row" style={{ marginTop: 12 }}>
        <button type="submit" disabled={busy}>
          Save list selection
        </button>
        {status ? (
          <span role="status" className="small">
            {status}
          </span>
        ) : null}
      </div>
    </form>
  );
}
