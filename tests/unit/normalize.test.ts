import { describe, expect, it } from "vitest";
import { canonicalJson, MAX_NOTES_LENGTH, normalizeProviderTask } from "@scholar/domain";
import { MALICIOUS_NOTE } from "@scholar/testing";

const base = {
  id: "t1",
  title: "Essay",
  status: "needsAction" as const,
  updated: "2026-11-04T10:00:00.000Z",
};

describe("provider task normalization", () => {
  it("maps status and date-only due", () => {
    const n = normalizeProviderTask({ ...base, due: "2026-11-05T00:00:00.000Z" });
    expect(n.status).toBe("needs_action");
    expect(n.dueDate).toBe("2026-11-05");
  });

  it("produces a stable version hash that changes with content", () => {
    const a = normalizeProviderTask(base);
    expect(normalizeProviderTask({ ...base }).versionHash).toBe(a.versionHash);
    expect(normalizeProviderTask({ ...base, title: "Essay v2" }).versionHash).not.toBe(
      a.versionHash,
    );
  });

  it("bounds notes and strips control characters", () => {
    const n = normalizeProviderTask({ ...base, notes: `a\u0000b${"x".repeat(MAX_NOTES_LENGTH)}` });
    expect(n.notes!.length).toBe(MAX_NOTES_LENGTH);
    expect(n.notes!.startsWith("ab")).toBe(true);
  });

  it("keeps only https web links", () => {
    expect(
      normalizeProviderTask({ ...base, webViewLink: "javascript:alert(1)" }).webViewLink,
    ).toBeNull();
    expect(
      normalizeProviderTask({ ...base, webViewLink: "https://tasks.google.com/x" }).webViewLink,
    ).toBe("https://tasks.google.com/x");
  });

  it("stores instruction-like notes verbatim as inert data (A14)", () => {
    const n = normalizeProviderTask({ ...base, notes: MALICIOUS_NOTE });
    expect(n.notes).toBe(MALICIOUS_NOTE);
  });

  it("serializes canonically regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
  });
});
