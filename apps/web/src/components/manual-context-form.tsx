"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "./api-client";

export interface ManualContextValue {
  title: string;
  requirements: string;
  sources: string[];
  dueDate: string | null;
  version: number;
}

/**
 * Student-supplied assignment details. Saved as written; links are shown but never fetched.
 * Used when Canvas is unavailable or the assignment is not in Canvas.
 */
export function ManualContextForm(props: {
  taskId: string;
  defaultTitle: string;
  existing: ManualContextValue | null;
}) {
  const router = useRouter();
  const e = props.existing;
  const [title, setTitle] = useState(e?.title ?? props.defaultTitle);
  const [requirements, setRequirements] = useState(e?.requirements ?? "");
  const [sources, setSources] = useState((e?.sources ?? []).join("\n"));
  const [dueDate, setDueDate] = useState(e?.dueDate ?? "");
  const [status, setStatus] = useState<string | null>(null);

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    setStatus(null);
    try {
      await apiFetch(`/tasks/${props.taskId}/manual-context`, {
        method: "PUT",
        body: {
          title,
          requirements,
          sources: sources
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean),
          dueDate: dueDate || null,
          dueAt: null,
          expectedVersion: e?.version ?? null,
        },
      });
      setStatus("Saved");
      router.refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not save");
    }
  }

  return (
    <form onSubmit={save} className="stack" aria-label="Your assignment details">
      <div className="field">
        <label htmlFor="mc-title">Assignment title</label>
        <input
          id="mc-title"
          value={title}
          onChange={(ev) => setTitle(ev.target.value)}
          maxLength={300}
          required
        />
      </div>
      <div className="field">
        <label htmlFor="mc-req">Requirements (paste from the syllabus or assignment sheet)</label>
        <textarea
          id="mc-req"
          value={requirements}
          onChange={(ev) => setRequirements(ev.target.value)}
          rows={6}
          maxLength={10_000}
          style={{ width: "100%" }}
        />
      </div>
      <div className="field">
        <label htmlFor="mc-sources">
          Source links (https, one per line — shown to you, never fetched)
        </label>
        <textarea
          id="mc-sources"
          value={sources}
          onChange={(ev) => setSources(ev.target.value)}
          rows={3}
          style={{ width: "100%" }}
        />
      </div>
      <div className="field">
        <label htmlFor="mc-due">Due date override (optional)</label>
        <input
          id="mc-due"
          type="date"
          value={dueDate}
          onChange={(ev) => setDueDate(ev.target.value)}
        />
      </div>
      <div className="row">
        <button type="submit">{e ? "Save details" : "Add details"}</button>
        {e ? (
          <button
            type="button"
            className="secondary"
            onClick={async () => {
              await apiFetch(`/tasks/${props.taskId}/manual-context`, { method: "DELETE" });
              router.refresh();
            }}
          >
            Remove details
          </button>
        ) : null}
        {status ? (
          <span role="status" className="small">
            {status}
          </span>
        ) : null}
      </div>
    </form>
  );
}
