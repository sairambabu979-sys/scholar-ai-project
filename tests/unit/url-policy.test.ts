import { describe, expect, it } from "vitest";
import {
  assertAllowedUrl,
  createGuardedFetch,
  createGuardedLookup,
  isDisallowedAddress,
  normalizeServiceOrigin,
  UrlPolicyError,
} from "@scholar/security";

describe("network address policy (A15/A16)", () => {
  it("refuses internal, metadata and smuggled addresses for IPv4 and IPv6", () => {
    for (const ip of [
      "127.0.0.1",
      "10.0.0.5",
      "172.16.3.4",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "fe80::1",
      "fc00::1",
      "fd00:ec2::254",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:a9fe:a9fe",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "2001:0:abcd::1",
      "2001:db8::1",
      "not-an-ip",
    ]) {
      expect(isDisallowedAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "151.101.1.69",
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
    ]) {
      expect(isDisallowedAddress(ip), ip).toBe(false);
    }
  });

  it("accepts only bare https origins with a DNS hostname for institution services", () => {
    expect(normalizeServiceOrigin("https://canvas.school.example/")).toBe(
      "https://canvas.school.example",
    );
    for (const [raw, code] of [
      ["http://canvas.school.example", "https_required"],
      ["https://user:pw@canvas.school.example", "credentials_in_url"],
      ["https://canvas.school.example:8443", "non_default_port"],
      ["https://canvas.school.example/api", "origin_only"],
      ["https://10.0.0.1", "ip_literal_host"],
      ["https://[::1]", "ip_literal_host"],
      ["https://localhost", "single_label_host"],
    ] as const) {
      expect(() => normalizeServiceOrigin(raw), raw).toThrow(code);
    }
  });

  it("allows requests only to configured origins", () => {
    const allowed = ["https://canvas.school.example"];
    expect(
      assertAllowedUrl("https://canvas.school.example/api/v1/courses?page=2", allowed).pathname,
    ).toBe("/api/v1/courses");
    expect(() => assertAllowedUrl("https://evil.example/api/v1/courses", allowed)).toThrow(
      "origin_not_allowed",
    );
    expect(() => assertAllowedUrl("http://canvas.school.example/api", allowed)).toThrow(
      "https_required",
    );
    expect(() => assertAllowedUrl("https://canvas.school.example.evil.example/", allowed)).toThrow(
      "origin_not_allowed",
    );
  });

  it("refuses a foreign URL before any DNS or network activity", async () => {
    let resolved = 0;
    const f = createGuardedFetch({
      allowedOrigins: ["https://canvas.school.example"],
      resolve: async () => {
        resolved++;
        return [{ address: "8.8.8.8", family: 4 }];
      },
    });
    await expect(f("https://evil.example/x", {})).rejects.toBeInstanceOf(UrlPolicyError);
    expect(resolved).toBe(0);
  });
});

describe("connect-time DNS validation (rebinding defence)", () => {
  const lookupWith = (answers: Array<{ address: string; family: number }>) => {
    const lookup = createGuardedLookup(async () => answers);
    return (opts: { all?: boolean; family?: number }) =>
      new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
        lookup("canvas.school.example", opts, (err, address, family) =>
          resolve({ err, address, family }),
        ),
      );
  };

  it("passes public answers through in both callback shapes", async () => {
    const one = await lookupWith([{ address: "151.101.1.69", family: 4 }])({});
    expect(one).toMatchObject({ err: null, address: "151.101.1.69", family: 4 });
    const all = await lookupWith([
      { address: "151.101.1.69", family: 4 },
      { address: "2606:4700::1", family: 6 },
    ])({ all: true });
    expect(all.err).toBeNull();
    expect(all.address).toHaveLength(2);
  });

  it("refuses when any answer is internal (DNS rebinding / split answers)", async () => {
    const r = await lookupWith([
      { address: "151.101.1.69", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ])({ all: true });
    expect(r.err).toBeInstanceOf(UrlPolicyError);
    expect((r.err as UrlPolicyError).code).toBe("address_not_allowed");
    const v6 = await lookupWith([{ address: "::ffff:10.0.0.1", family: 6 }])({});
    expect((v6.err as UrlPolicyError).code).toBe("address_not_allowed");
  });
});
