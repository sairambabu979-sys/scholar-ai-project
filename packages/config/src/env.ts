import { z } from "zod";

/** Fallback used only outside production so a fresh checkout boots. Never valid in production. */
export const DEV_FALLBACK_AUTH_SECRET = "scholar-ai-insecure-development-secret-do-not-use";
/** Documented local default for the synthetic demo accounts (mock mode only). */
export const DEFAULT_DEMO_PASSWORD = "scholar-demo-local";
const LOCAL_DB_PASSWORD_MARKER = "local-development-only";

const emptyToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const booleanFlag = z.preprocess(
  emptyToUndefined,
  z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
);

const rawSchema = z.object({
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(["development", "test", "production"]).default("development"),
  ),
  APP_URL: z.preprocess(emptyToUndefined, z.url().default("http://localhost:3000")),
  DATABASE_URL: z.preprocess(
    emptyToUndefined,
    z.string({ error: "DATABASE_URL is required" }).regex(/^postgres(ql)?:\/\//, {
      error: "DATABASE_URL must be a postgresql:// URL",
    }),
  ),
  AUTH_SECRET: optionalString,
  AUTH_ALLOWED_EMAILS: optionalString,
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_AUTH_REDIRECT_URI: optionalString,
  GOOGLE_TASKS_REDIRECT_URI: optionalString,
  CANVAS_ENABLED: booleanFlag,
  CANVAS_BASE_URL: optionalString,
  CANVAS_CLIENT_ID: optionalString,
  CANVAS_CLIENT_SECRET: optionalString,
  CANVAS_REDIRECT_URI: optionalString,
  TOKEN_KEY_ID: z.preprocess(emptyToUndefined, z.string().default("local-v1")),
  TOKEN_ENCRYPTION_KEY_BASE64: optionalString,
  AI_PROVIDER: z.preprocess(emptyToUndefined, z.enum(["anthropic"]).default("anthropic")),
  ANTHROPIC_API_KEY: optionalString,
  AI_MODEL: optionalString,
  AI_DAILY_LIMIT_USD: z.preprocess(emptyToUndefined, z.coerce.number().min(0).max(1000).default(2)),
  SYNC_INTERVAL_SECONDS: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().min(60).max(86_400).default(900),
  ),
  INTEGRATIONS_MODE: z.preprocess(emptyToUndefined, z.enum(["mock", "live"]).default("mock")),
  EXTERNAL_WRITES_ENABLED: booleanFlag,
  DEMO_PASSWORD: optionalString,
});

export type IntegrationsMode = "mock" | "live";

export interface AppEnv {
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  appUrl: string;
  appOrigin: string;
  databaseUrl: string;
  authSecret: string;
  authAllowedEmails: string[];
  google: {
    clientId?: string;
    clientSecret?: string;
    authRedirectUri?: string;
    tasksRedirectUri?: string;
    signInConfigured: boolean;
  };
  canvas: {
    enabled: boolean;
    baseUrl?: string;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
  };
  tokenKeyId: string;
  tokenEncryptionKeyConfigured: boolean;
  ai: { provider: "anthropic"; apiKeyConfigured: boolean; model?: string; dailyLimitUsd: number };
  syncIntervalSeconds: number;
  integrationsMode: IntegrationsMode;
  externalWritesEnabled: boolean;
  /** Present only in mock mode outside production. */
  demoPassword?: string;
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid Scholar AI configuration:\n - ${issues.join("\n - ")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface ParsedEnv {
  env: AppEnv;
  warnings: string[];
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * Validate configuration. Pure: takes the raw variables, returns the typed config or throws a
 * ConfigError listing every problem. Production refuses mock data, missing or weak secrets,
 * local credentials, and premature external-write enabling.
 */
export function parseEnv(raw: Record<string, string | undefined>): ParsedEnv {
  const parsed = rawSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const r = parsed.data;
  const issues: string[] = [];
  const warnings: string[] = [];
  const isProduction = r.NODE_ENV === "production";
  const appUrl = new URL(r.APP_URL);

  // --- secrets -------------------------------------------------------------------------
  let authSecret = r.AUTH_SECRET;
  if (!authSecret) {
    if (isProduction) issues.push("AUTH_SECRET is required in production");
    else warnings.push("AUTH_SECRET is empty; using an insecure development-only secret");
    authSecret = DEV_FALLBACK_AUTH_SECRET;
  } else if (authSecret.length < 32) {
    issues.push("AUTH_SECRET must be at least 32 characters");
  }
  if (isProduction && authSecret === DEV_FALLBACK_AUTH_SECRET) {
    issues.push("AUTH_SECRET must not be the development fallback in production");
  }

  if (r.TOKEN_ENCRYPTION_KEY_BASE64) {
    const bytes = Buffer.from(r.TOKEN_ENCRYPTION_KEY_BASE64, "base64");
    if (bytes.length !== 32) issues.push("TOKEN_ENCRYPTION_KEY_BASE64 must decode to 32 bytes");
  }

  const authAllowedEmails = (r.AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  // --- mode and writes -----------------------------------------------------------------
  if (r.EXTERNAL_WRITES_ENABLED) {
    issues.push(
      "EXTERNAL_WRITES_ENABLED=true is not allowed: the approved write executor (milestone M5) is not implemented in this build",
    );
  }

  const googleSignInConfigured = Boolean(r.GOOGLE_CLIENT_ID && r.GOOGLE_CLIENT_SECRET);
  if (r.INTEGRATIONS_MODE === "live" && !googleSignInConfigured) {
    issues.push(
      "INTEGRATIONS_MODE=live requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (demo sign-in is mock-only)",
    );
  }
  if (Boolean(r.GOOGLE_CLIENT_ID) !== Boolean(r.GOOGLE_CLIENT_SECRET)) {
    issues.push("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together");
  }
  for (const [name, value] of [
    ["GOOGLE_AUTH_REDIRECT_URI", r.GOOGLE_AUTH_REDIRECT_URI],
    ["GOOGLE_TASKS_REDIRECT_URI", r.GOOGLE_TASKS_REDIRECT_URI],
    ["CANVAS_REDIRECT_URI", r.CANVAS_REDIRECT_URI],
  ] as const) {
    if (value && !sameOrigin(value, r.APP_URL)) {
      issues.push(`${name} must use the APP_URL origin (${appUrl.origin})`);
    }
  }

  // --- Canvas ----------------------------------------------------------------------------
  if (r.CANVAS_ENABLED) {
    let validBase = false;
    if (r.CANVAS_BASE_URL) {
      try {
        const u = new URL(r.CANVAS_BASE_URL);
        validBase =
          u.protocol === "https:" && (u.pathname === "/" || u.pathname === "") && !u.search;
      } catch {
        validBase = false;
      }
    }
    if (!validBase) issues.push("CANVAS_ENABLED=true requires CANVAS_BASE_URL as an https origin");
    if (!r.CANVAS_CLIENT_ID || !r.CANVAS_CLIENT_SECRET) {
      issues.push("CANVAS_ENABLED=true requires CANVAS_CLIENT_ID and CANVAS_CLIENT_SECRET");
    }
    warnings.push(
      "CANVAS_ENABLED=true but the Canvas integration is not implemented in this build",
    );
  }

  // --- production hardening --------------------------------------------------------------
  if (isProduction) {
    if (r.INTEGRATIONS_MODE !== "live") {
      issues.push("INTEGRATIONS_MODE must be 'live' in production (mock data is never served)");
    }
    if (appUrl.protocol !== "https:") issues.push("APP_URL must use https in production");
    if (r.DATABASE_URL.includes(LOCAL_DB_PASSWORD_MARKER)) {
      issues.push("DATABASE_URL uses the local development credential");
    }
    if (authAllowedEmails.length === 0) {
      issues.push("AUTH_ALLOWED_EMAILS is required in production");
    }
    if (!r.TOKEN_ENCRYPTION_KEY_BASE64) {
      issues.push("TOKEN_ENCRYPTION_KEY_BASE64 (or a managed key store) is required in production");
    }
    if (r.DEMO_PASSWORD) issues.push("DEMO_PASSWORD must not be set in production");
  }

  if (issues.length > 0) throw new ConfigError(issues);

  const env: AppEnv = {
    nodeEnv: r.NODE_ENV,
    isProduction,
    appUrl: r.APP_URL.replace(/\/+$/, ""),
    appOrigin: appUrl.origin,
    databaseUrl: r.DATABASE_URL,
    authSecret,
    authAllowedEmails,
    google: {
      clientId: r.GOOGLE_CLIENT_ID,
      clientSecret: r.GOOGLE_CLIENT_SECRET,
      authRedirectUri: r.GOOGLE_AUTH_REDIRECT_URI,
      tasksRedirectUri: r.GOOGLE_TASKS_REDIRECT_URI,
      signInConfigured: googleSignInConfigured,
    },
    canvas: {
      enabled: r.CANVAS_ENABLED,
      baseUrl: r.CANVAS_BASE_URL,
      clientId: r.CANVAS_CLIENT_ID,
      clientSecret: r.CANVAS_CLIENT_SECRET,
      redirectUri: r.CANVAS_REDIRECT_URI,
    },
    tokenKeyId: r.TOKEN_KEY_ID,
    tokenEncryptionKeyConfigured: Boolean(r.TOKEN_ENCRYPTION_KEY_BASE64),
    ai: {
      provider: r.AI_PROVIDER,
      apiKeyConfigured: Boolean(r.ANTHROPIC_API_KEY),
      model: r.AI_MODEL,
      dailyLimitUsd: r.AI_DAILY_LIMIT_USD,
    },
    syncIntervalSeconds: r.SYNC_INTERVAL_SECONDS,
    integrationsMode: r.INTEGRATIONS_MODE,
    externalWritesEnabled: r.EXTERNAL_WRITES_ENABLED,
    demoPassword:
      r.INTEGRATIONS_MODE === "mock" && !isProduction
        ? (r.DEMO_PASSWORD ?? DEFAULT_DEMO_PASSWORD)
        : undefined,
  };
  return { env, warnings };
}

let cached: AppEnv | undefined;

/** Parse `process.env` once per process. Throws ConfigError on invalid configuration. */
export function getEnv(): AppEnv {
  if (!cached) {
    const { env, warnings } = parseEnv(process.env);
    for (const w of warnings) console.warn(`[config] ${w}`);
    cached = env;
  }
  return cached;
}

/** Test helper: forget the cached configuration. */
export function resetEnvCache(): void {
  cached = undefined;
}
