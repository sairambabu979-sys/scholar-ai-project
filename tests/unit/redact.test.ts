import { describe, expect, it } from "vitest";
import { createLogger, redact, redactString, REDACTED } from "@scholar/security";

describe("redaction (A30)", () => {
  it("removes secret-bearing keys at any depth", () => {
    const out = redact({
      refresh_token: "1//abc",
      nested: { accessToken: "ya29.zzz", apiKey: "sk-ant-123", ok: 3 },
      headers: { authorization: "Bearer abc.def" },
    }) as {
      refresh_token: string;
      nested: Record<string, unknown>;
      headers: Record<string, unknown>;
    };
    expect(out.refresh_token).toBe(REDACTED);
    expect(out.nested.accessToken).toBe(REDACTED);
    expect(out.nested.apiKey).toBe(REDACTED);
    expect(out.nested.ok).toBe(3);
    expect(out.headers.authorization).toBe(REDACTED);
  });

  it("scrubs token-shaped substrings in free text", () => {
    const s = redactString(
      "call failed Bearer abc123 ya29.A0ARrdaM token 1//0gLONGREFRESHTOKENVALUE123 sk-ant-api03-xyz " +
        "postgresql://scholar:hunter2@db/scholar https://x.example/cb?code=SECRET&state=STATE",
    );
    for (const leaked of [
      "abc123",
      "ya29.A0",
      "1//0gLONG",
      "sk-ant-api03",
      "hunter2",
      "SECRET",
      "STATE",
    ]) {
      expect(s).not.toContain(leaked);
    }
  });

  it("omits academic content fields by default", () => {
    const out = redact({ notes: "my essay", title: "Essay", count: 2 }) as Record<string, unknown>;
    expect(out.notes).toBe("[Omitted]");
    expect(out.title).toBe("[Omitted]");
    expect(out.count).toBe(2);
  });

  it("logger output never contains secrets", () => {
    const lines: string[] = [];
    const log = createLogger({ service: "t" }, "debug", (l) => lines.push(l));
    log.info("oauth", { access_token: "ya29.secret", error: new Error("Bearer leaked-token") });
    expect(lines.join()).not.toContain("ya29.secret");
    expect(lines.join()).not.toContain("leaked-token");
  });
});
