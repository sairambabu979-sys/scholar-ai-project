/**
 * Redaction for logs and error reports. Logs carry request IDs, safe error codes, action IDs,
 * timings and aggregate counts. Secrets and academic content are excluded by default.
 */

export const REDACTED = "[REDACTED]";

/** Keys whose values are always secret, matched case-insensitively against the key name. */
const SECRET_KEY_PATTERN =
  /(pass(word)?|secret|token|authorization|cookie|api[-_]?key|credential|private[-_]?key|client[-_]?secret|session|code_verifier|refresh|bearer)/i;

/** Keys that hold academic or personal content; excluded from logs by default. */
const CONTENT_KEY_PATTERN = /^(notes|title|description|body|content|contentMarkdown|text|email)$/i;

const STRING_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g, `Bearer ${REDACTED}`],
  [/\bya29\.[A-Za-z0-9\-_]+/g, REDACTED], // Google access tokens
  [/\b1\/\/[A-Za-z0-9\-_]{20,}/g, REDACTED], // Google refresh tokens
  [/\bsk-ant-[A-Za-z0-9\-_]+/g, REDACTED], // Anthropic API keys
  [/\b\d{4,6}~[A-Za-z0-9]{30,}\b/g, REDACTED], // Canvas access tokens
  [/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g, `$1${REDACTED}@`], // DB URL passwords
  [
    /([?&](?:code|state|access_token|refresh_token|client_secret|token)=)[^&\s#]+/gi,
    `$1${REDACTED}`,
  ],
];

export function redactString(input: string): string {
  let out = input;
  for (const [pattern, replacement] of STRING_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export interface RedactOptions {
  /** Include academic/personal content fields instead of dropping them. Default false. */
  includeContent?: boolean;
  maxDepth?: number;
}

export function redact(value: unknown, options: RedactOptions = {}, depth = 0): unknown {
  const maxDepth = options.maxDepth ?? 6;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (depth >= maxDepth) return "[Truncated]";
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, options, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) out[key] = REDACTED;
      else if (!options.includeContent && CONTENT_KEY_PATTERN.test(key)) out[key] = "[Omitted]";
      else out[key] = redact(v, options, depth + 1);
    }
    return out;
  }
  return "[Unserializable]";
}
