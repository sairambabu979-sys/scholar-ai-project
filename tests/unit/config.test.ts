import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_DEMO_PASSWORD, parseEnv } from "@scholar/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "dotenv";

const template = parse(readFileSync(path.resolve(__dirname, "../../.env.example")));

const prodBase = {
  NODE_ENV: "production",
  APP_URL: "https://scholar.app.example",
  DATABASE_URL: "postgresql://scholar_app:strong-unique-credential@db.internal:5432/scholar",
  AUTH_SECRET: "x".repeat(40),
  AUTH_ALLOWED_EMAILS: "student@school.example",
  GOOGLE_CLIENT_ID: "client-id",
  GOOGLE_CLIENT_SECRET: "client-secret",
  GOOGLE_AUTH_REDIRECT_URI: "https://scholar.app.example/api/auth/callback/google",
  GOOGLE_TASKS_REDIRECT_URI: "https://scholar.app.example/api/v1/integrations/google/callback",
  CANVAS_REDIRECT_URI: "https://scholar.app.example/api/v1/integrations/canvas/callback",
  TOKEN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
  INTEGRATIONS_MODE: "live",
  EXTERNAL_WRITES_ENABLED: "false",
};

const issuesOf = (raw: Record<string, string | undefined>) => {
  try {
    parseEnv(raw);
    return [];
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
};

describe("environment validation", () => {
  it("accepts the committed template for local development", () => {
    const { env, warnings } = parseEnv(template);
    expect(env.integrationsMode).toBe("mock");
    expect(env.externalWritesEnabled).toBe(false);
    expect(env.demoPassword).toBe(DEFAULT_DEMO_PASSWORD);
    expect(warnings.some((w) => w.includes("AUTH_SECRET"))).toBe(true);
  });

  it("keeps every secret in the template empty", () => {
    for (const key of [
      "AUTH_SECRET",
      "GOOGLE_CLIENT_SECRET",
      "CANVAS_CLIENT_SECRET",
      "TOKEN_ENCRYPTION_KEY_BASE64",
      "ANTHROPIC_API_KEY",
      "DEMO_PASSWORD",
    ]) {
      expect(template[key], key).toBe("");
    }
  });

  it("accepts a hardened production configuration", () => {
    expect(issuesOf(prodBase)).toEqual([]);
    expect(parseEnv(prodBase).env.demoPassword).toBeUndefined();
  });

  it("refuses mock data in production", () => {
    expect(issuesOf({ ...prodBase, INTEGRATIONS_MODE: "mock" }).join()).toMatch(
      /INTEGRATIONS_MODE/,
    );
  });

  it("refuses missing, weak or development secrets in production", () => {
    expect(issuesOf({ ...prodBase, AUTH_SECRET: "" }).join()).toMatch(/AUTH_SECRET is required/);
    expect(issuesOf({ ...prodBase, AUTH_SECRET: "short" }).join()).toMatch(/at least 32/);
    expect(issuesOf({ ...prodBase, TOKEN_ENCRYPTION_KEY_BASE64: "" }).join()).toMatch(
      /TOKEN_ENCRYPTION_KEY/,
    );
    expect(issuesOf({ ...prodBase, TOKEN_ENCRYPTION_KEY_BASE64: "c2hvcnQ=" }).join()).toMatch(
      /32 bytes/,
    );
    expect(
      issuesOf({
        ...prodBase,
        DATABASE_URL: "postgresql://scholar:local-development-only@localhost/scholar",
      }).join(),
    ).toMatch(/local development credential/);
    expect(issuesOf({ ...prodBase, APP_URL: "http://scholar.app.example" }).join()).toMatch(
      /https/,
    );
    expect(issuesOf({ ...prodBase, AUTH_ALLOWED_EMAILS: "" }).join()).toMatch(
      /AUTH_ALLOWED_EMAILS/,
    );
    expect(issuesOf({ ...prodBase, DEMO_PASSWORD: "x" }).join()).toMatch(/DEMO_PASSWORD/);
  });

  it("refuses enabling external writes before the M5 executor exists", () => {
    expect(issuesOf({ ...template, EXTERNAL_WRITES_ENABLED: "true" }).join()).toMatch(
      /EXTERNAL_WRITES_ENABLED/,
    );
    expect(issuesOf({ ...prodBase, EXTERNAL_WRITES_ENABLED: "true" }).join()).toMatch(
      /EXTERNAL_WRITES_ENABLED/,
    );
  });

  it("requires redirect URIs on the app origin", () => {
    expect(
      issuesOf({ ...prodBase, GOOGLE_TASKS_REDIRECT_URI: "https://evil.example/callback" }).join(),
    ).toMatch(/GOOGLE_TASKS_REDIRECT_URI/);
  });

  it("requires an https origin for Canvas when enabled", () => {
    const base = {
      ...template,
      TOKEN_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"),
      CANVAS_ENABLED: "true",
      CANVAS_CLIENT_ID: "a",
      CANVAS_CLIENT_SECRET: "b",
    };
    expect(issuesOf({ ...base, CANVAS_BASE_URL: "http://canvas.school.example" }).join()).toMatch(
      /CANVAS_BASE_URL/,
    );
    expect(
      issuesOf({ ...base, CANVAS_BASE_URL: "https://canvas.school.example/x" }).join(),
    ).toMatch(/CANVAS_BASE_URL/);
    expect(issuesOf({ ...base, CANVAS_BASE_URL: "https://canvas.school.example" })).toEqual([]);
  });

  it("live mode requires a token encryption key and the Tasks redirect URI", () => {
    const live = {
      ...template,
      INTEGRATIONS_MODE: "live",
      GOOGLE_CLIENT_ID: "id",
      GOOGLE_CLIENT_SECRET: "secret",
    };
    expect(issuesOf({ ...live, GOOGLE_TASKS_REDIRECT_URI: "" }).join()).toMatch(
      /GOOGLE_TASKS_REDIRECT_URI/,
    );
    expect(issuesOf(live).join()).toMatch(/TOKEN_ENCRYPTION_KEY_BASE64/);
    const key = Buffer.alloc(32, 1).toString("base64");
    expect(issuesOf({ ...live, TOKEN_ENCRYPTION_KEY_BASE64: key })).toEqual([]);
    expect(
      parseEnv({ ...live, TOKEN_ENCRYPTION_KEY_BASE64: key }).env.demoPassword,
    ).toBeUndefined();
  });

  it("validates key ids and rotation keys", () => {
    expect(issuesOf({ ...template, TOKEN_KEY_ID: "has space" }).join()).toMatch(/TOKEN_KEY_ID/);
    expect(
      issuesOf({ ...template, TOKEN_ENCRYPTION_PREVIOUS_KEYS: "old:c2hvcnQ=" }).join(),
    ).toMatch(/PREVIOUS_KEYS/);
    const ok = `old:${Buffer.alloc(32, 2).toString("base64")}`;
    expect(issuesOf({ ...template, TOKEN_ENCRYPTION_PREVIOUS_KEYS: ok })).toEqual([]);
  });

  it("accepts only read-only Canvas scopes", () => {
    expect(issuesOf({ ...template, CANVAS_SCOPES: "url:GET|/api/v1/courses" })).toEqual([]);
    expect(
      issuesOf({
        ...template,
        CANVAS_SCOPES: "url:POST|/api/v1/courses/:id/assignments/:id/submissions",
      }).join(),
    ).toMatch(/CANVAS_SCOPES/);
    expect(issuesOf({ ...template, CANVAS_SCOPES: "url:PUT|/api/v1/x" }).join()).toMatch(
      /CANVAS_SCOPES/,
    );
  });

  it("live mode requires Google sign-in credentials", () => {
    expect(issuesOf({ ...template, INTEGRATIONS_MODE: "live" }).join()).toMatch(/GOOGLE_CLIENT_ID/);
  });
});
