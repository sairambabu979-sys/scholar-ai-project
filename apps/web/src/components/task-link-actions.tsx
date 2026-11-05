"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "./api-client";

/** Confirms ONE specific assignment for a task. Nothing is ever linked without this click. */
export function ConfirmLinkButton(props: {
  taskId: string;
  assignmentId: string;
  method: "url" | "suggested";
  confidence: number;
  reasons: string[];
  expectedTaskVersion: string;
  label: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span className="row">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await apiFetch(`/tasks/${props.taskId}/link`, {
              method: "PUT",
              body: {
                assignmentId: props.assignmentId,
                method: props.method,
                confidence: props.confidence,
                reasons: props.reasons,
                expectedTaskVersion: props.expectedTaskVersion,
              },
            });
            router.refresh();
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not link");
            setBusy(false);
          }
        }}
      >
        {props.label}
      </button>
      {error ? (
        <span role="alert" className="error small">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function AssignmentPicker(props: {
  taskId: string;
  expectedTaskVersion: string;
  options: Array<{ id: string; label: string }>;
}) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!value) return;
        setError(null);
        try {
          await apiFetch(`/tasks/${props.taskId}/link`, {
            method: "PUT",
            body: {
              assignmentId: value,
              method: "manual",
              expectedTaskVersion: props.expectedTaskVersion,
            },
          });
          router.refresh();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Could not link");
        }
      }}
    >
      <div className="field">
        <label htmlFor="assignment-picker">Or choose any assignment</label>
        <select id="assignment-picker" value={value} onChange={(e) => setValue(e.target.value)}>
          <option value="">Select an assignment…</option>
          {props.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" disabled={!value} className="secondary">
        Link selected assignment
      </button>
      {error ? (
        <span role="alert" className="error small">
          {error}
        </span>
      ) : null}
    </form>
  );
}

export function UnlinkButton({ taskId }: { taskId: string }) {
  const router = useRouter();
  return (
    <button
      type="button"
      className="secondary"
      onClick={async () => {
        await apiFetch(`/tasks/${taskId}/link`, { method: "DELETE" });
        router.refresh();
      }}
    >
      Unlink assignment
    </button>
  );
}
