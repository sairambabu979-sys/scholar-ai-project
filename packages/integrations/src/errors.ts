/**
 * Provider failures, classified for retry policy. `code` is a safe, stable identifier that may
 * be stored and shown; `message` must never contain tokens or provider response bodies.
 */
export type ProviderErrorKind =
  | "retryable" // network, 5xx, throttling — retry with backoff
  | "auth" // credential rejected — refresh once, then reconnect
  | "not_found" // resource gone or access lost
  | "unavailable" // capability not implemented/configured — do not retry
  | "fatal"; // malformed response or programming error — do not retry

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly code: string;
  readonly retryAfterMs?: number;

  constructor(kind: ProviderErrorKind, code: string, message?: string, retryAfterMs?: number) {
    super(message ?? code);
    this.name = "ProviderError";
    this.kind = kind;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable(): boolean {
    return this.kind === "retryable";
  }
}

export function isProviderError(e: unknown): e is ProviderError {
  return e instanceof ProviderError;
}
