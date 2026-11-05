/** Minimal fetch signature so callers (and tests) can inject the HTTP transport. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export const DEFAULT_TIMEOUT_MS = 15_000;

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds, bounded to 10 minutes. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(ms, 10 * 60_000);
}
