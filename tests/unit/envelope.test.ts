import { randomBytes, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EnvelopeError, Keyring, open, reseal, seal, sealedKeyId } from "@scholar/security";

const key = (id: string) => ({ id, key: randomBytes(32) });

describe("token envelope encryption", () => {
  const k1 = key("k1");
  const ring = new Keyring(k1);

  it("round-trips and never contains the plaintext", () => {
    const sealed = seal(ring, "ya29.secret-access-token", "integration-1:user-1");
    expect(sealed).not.toContain("ya29");
    expect(sealedKeyId(sealed)).toBe("k1");
    expect(open(ring, sealed, "integration-1:user-1")).toBe("ya29.secret-access-token");
  });

  it("uses a fresh data key and IV every time", () => {
    expect(seal(ring, "same", "aad")).not.toBe(seal(ring, "same", "aad"));
  });

  it("fails to open when moved to another owner/row (AAD binding)", () => {
    const sealed = seal(ring, "token", "integration-1:user-1");
    expect(() => open(ring, sealed, "integration-2:user-2")).toThrow(EnvelopeError);
  });

  it("detects any tampering", () => {
    const sealed = seal(ring, "token", "aad");
    const parts = sealed.split(".");
    for (const i of [3, 6, 7]) {
      const copy = [...parts];
      const b = Buffer.from(copy[i]!, "base64url");
      b[0] = b[0]! ^ 1;
      copy[i] = b.toString("base64url");
      expect(() => open(ring, copy.join("."), "aad")).toThrow(EnvelopeError);
    }
    expect(() => open(ring, "v1.k1.short", "aad")).toThrow(EnvelopeError);
  });

  it("refuses unknown keys and supports rotation through previous keys", () => {
    const sealedOld = seal(ring, "token", "aad");
    const k2 = key("k2");
    expect(() => open(new Keyring(k2), sealedOld, "aad")).toThrow(/Unknown root key/);
    const rotated = new Keyring(k2, [k1]);
    expect(open(rotated, sealedOld, "aad")).toBe("token");
    const rewrapped = reseal(rotated, sealedOld, "aad");
    expect(sealedKeyId(rewrapped)).toBe("k2");
    expect(open(new Keyring(k2), rewrapped, "aad")).toBe("token");
  });

  it("validates key material", () => {
    expect(() => new Keyring({ id: "k", key: randomBytes(16) })).toThrow(/32 bytes/);
    expect(() => new Keyring({ id: "bad id!", key: randomBytes(32) })).toThrow(/key id/);
    const prev = `old:${randomBytes(32).toString("base64")}`;
    const r = Keyring.fromConfig({
      keyId: "new",
      keyBase64: randomBytes(32).toString("base64"),
      previous: prev,
    });
    expect(r.get("old")).toBeDefined();
    expect(createHash("sha256").update(r.current.key).digest("hex")).toHaveLength(64);
  });
});
