import { createHash } from "node:crypto";
import { parseGoogleDueDate, type DateOnly } from "./dates.ts";

/** Bounds applied to provider text before storage. */
export const MAX_TITLE_LENGTH = 1024;
export const MAX_NOTES_LENGTH = 8192;

/** Provider-neutral view of a Google Task used by sync. */
export interface ProviderTaskInput {
  id: string;
  title?: string | null;
  notes?: string | null;
  status: "needsAction" | "completed";
  due?: string | null;
  completed?: string | null;
  parent?: string | null;
  position?: string | null;
  hidden?: boolean | null;
  deleted?: boolean | null;
  updated: string;
  etag?: string | null;
  webViewLink?: string | null;
}

export interface NormalizedTask {
  externalId: string;
  title: string;
  notes: string | null;
  status: "needs_action" | "completed";
  dueDate: DateOnly | null;
  completedAt: string | null;
  parentExternalId: string | null;
  position: string | null;
  hidden: boolean;
  deleted: boolean;
  webViewLink: string | null;
  providerUpdatedAt: string;
  etag: string | null;
  versionHash: string;
}

function bound(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  // Strip control characters except tab/newline; text is stored and rendered as plain text.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function safeHttpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function canonicalIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Normalize a provider task. Task text is untrusted content: it is bounded and stored as
 * data, never interpreted as instructions or used to choose any action.
 */
export function normalizeProviderTask(t: ProviderTaskInput): NormalizedTask {
  const updated = canonicalIso(t.updated);
  if (!updated) throw new RangeError("Task is missing a valid updated timestamp");
  const base = {
    externalId: t.id,
    title: bound(t.title ?? "", MAX_TITLE_LENGTH) ?? "",
    notes: bound(t.notes, MAX_NOTES_LENGTH),
    status: t.status === "completed" ? ("completed" as const) : ("needs_action" as const),
    dueDate: t.due ? parseGoogleDueDate(t.due) : null,
    completedAt: canonicalIso(t.completed),
    parentExternalId: t.parent ?? null,
    position: t.position ?? null,
    hidden: Boolean(t.hidden),
    deleted: Boolean(t.deleted),
    webViewLink: safeHttpsUrl(t.webViewLink),
    providerUpdatedAt: updated,
    etag: t.etag ?? null,
  };
  return { ...base, versionHash: hashCanonical(base) };
}

/** Deterministic JSON serialization (sorted keys) for hashing snapshots. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
