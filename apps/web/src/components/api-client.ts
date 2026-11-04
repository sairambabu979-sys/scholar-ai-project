"use client";

export class ClientApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Same-origin JSON fetch against /api/v1 with the standard envelope. */
export async function apiFetch<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  const json = (await res.json().catch(() => null)) as {
    data?: T;
    error?: { code: string; message: string };
  } | null;
  if (!res.ok || !json || json.error) {
    throw new ClientApiError(
      json?.error?.code ?? "network_error",
      json?.error?.message ?? "Request failed",
      res.status,
    );
  }
  return json.data as T;
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** Poll an owned job until it reaches a terminal state (or the timeout passes). */
export async function waitForJob(jobId: string, timeoutMs = 60_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const job = await apiFetch<{ status: string }>(`/jobs/${jobId}`);
    if (TERMINAL.has(job.status)) return job.status;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "timeout";
}
