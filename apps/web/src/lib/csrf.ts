/**
 * CSRF defence for cookie-authenticated mutations: the request must come from our own origin.
 * Browsers always send Origin on cross-origin POST/PUT/PATCH/DELETE; Sec-Fetch-Site is the
 * fallback. Requests with neither are rejected. Mutations are never accepted via GET.
 */
export function isSameOriginRequest(
  headers: { get(name: string): string | null },
  appOrigin: string,
): boolean {
  const origin = headers.get("origin");
  if (origin) return origin === appOrigin;
  const site = headers.get("sec-fetch-site");
  return site === "same-origin";
}
