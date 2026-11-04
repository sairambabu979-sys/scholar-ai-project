import { describe, expect, it } from "vitest";
import { isSameOriginRequest } from "../../apps/web/src/lib/csrf.ts";

const h = (entries: Record<string, string>) => new Headers(entries);
const origin = "http://localhost:3000";

describe("CSRF origin check", () => {
  it("accepts same-origin requests", () => {
    expect(isSameOriginRequest(h({ origin }), origin)).toBe(true);
    expect(isSameOriginRequest(h({ "sec-fetch-site": "same-origin" }), origin)).toBe(true);
  });
  it("rejects cross-origin or unlabelled requests", () => {
    expect(isSameOriginRequest(h({ origin: "https://evil.example" }), origin)).toBe(false);
    expect(isSameOriginRequest(h({ origin: "http://localhost:3000.evil.example" }), origin)).toBe(
      false,
    );
    expect(isSameOriginRequest(h({ "sec-fetch-site": "cross-site" }), origin)).toBe(false);
    expect(isSameOriginRequest(h({}), origin)).toBe(false);
  });
});
