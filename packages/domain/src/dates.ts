/**
 * Date handling rules (SCHOLAR_AI_PLAN.md §3, §7, acceptance A04):
 *  - A Google Tasks `due` value is a calendar DATE expressed as an RFC3339 timestamp at UTC
 *    midnight. Extract the date part; never shift it through any timezone.
 *  - "Today" for a student is computed in their IANA timezone.
 *  - Date-only values are carried as `YYYY-MM-DD` strings; in the database they are SQL
 *    `date` columns, which drivers surface as a JS Date at UTC midnight.
 */

export type DateOnly = string & { readonly __brand?: "DateOnly" };

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isValidDateOnly(value: string): value is DateOnly {
  const m = DATE_ONLY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * Extract the calendar date from a Google Tasks `due` field. The date part of the string is
 * authoritative; time and offset are ignored (Google always sends midnight UTC, and does not
 * expose time-of-day through this field).
 */
export function parseGoogleDueDate(due: string): DateOnly {
  const m = RFC3339_RE.exec(due);
  if (!m) throw new RangeError("Malformed Google Tasks due value");
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (!isValidDateOnly(date)) throw new RangeError("Invalid calendar date in due value");
  return date;
}

/** Convert a date-only string to the JS Date representation used for SQL `date` columns. */
export function dateOnlyToDbDate(date: DateOnly): Date {
  if (!isValidDateOnly(date)) throw new RangeError("Invalid date-only value");
  return new Date(`${date}T00:00:00.000Z`);
}

/** Convert a SQL `date` (JS Date at UTC midnight) back to `YYYY-MM-DD` using UTC fields only. */
export function dbDateToDateOnly(value: Date): DateOnly {
  const y = value.getUTCFullYear().toString().padStart(4, "0");
  const m = (value.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = value.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date at instant `now` in IANA timezone `tz`. */
export function todayInTimeZone(now: Date, tz: string): DateOnly {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(date: DateOnly, days: number): DateOnly {
  const d = dateOnlyToDbDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return dbDateToDateOnly(d);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function daysBetween(from: DateOnly, to: DateOnly): number {
  return Math.round(
    (dateOnlyToDbDate(to).getTime() - dateOnlyToDbDate(from).getTime()) / 86_400_000,
  );
}

/**
 * Human-readable label for a date-only value, e.g. "Thu, Nov 5, 2026". Formatted in UTC
 * because the value is a calendar date, not an instant — this never shifts the day.
 */
export function formatDateOnly(date: DateOnly, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(dateOnlyToDbDate(date));
}

/** Format an instant in the student's timezone, e.g. "Nov 4, 2026, 3:15 PM". */
export function formatInstant(value: Date, tz: string, locale = "en-US"): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}
