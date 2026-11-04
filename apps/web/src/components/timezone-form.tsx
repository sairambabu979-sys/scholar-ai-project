"use client";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "./api-client";

const noopSubscribe = () => () => {};

export function TimezoneForm({ current }: { current: string }) {
  const router = useRouter();
  const zones = useMemo(() => {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      return [current];
    }
  }, [current]);
  const [value, setValue] = useState(current);
  // Device timezone is only known in the browser; null during server render.
  const detected = useSyncExternalStore(
    noopSubscribe,
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
    () => null,
  );
  const [status, setStatus] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    try {
      await apiFetch("/me/preferences", { method: "PATCH", body: { timezone: value } });
      setStatus("Saved");
      router.refresh();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Could not save");
    }
  }

  return (
    <form onSubmit={save} className="row">
      <div className="field">
        <label htmlFor="timezone">Timezone</label>
        <select id="timezone" value={value} onChange={(e) => setValue(e.target.value)}>
          {(zones.includes(value) ? zones : [value, ...zones]).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </select>
        {detected && detected !== value ? (
          <p className="small muted">
            Your device reports {detected}.{" "}
            <button type="button" className="secondary" onClick={() => setValue(detected)}>
              Use it
            </button>
          </p>
        ) : null}
      </div>
      <button type="submit">Save timezone</button>
      {status ? (
        <span role="status" className="small">
          {status}
        </span>
      ) : null}
    </form>
  );
}
