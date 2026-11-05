/**
 * Authenticated envelope encryption for integration credentials (SCHOLAR_AI_PLAN.md §5).
 *
 *  - Each sealed value gets a fresh random 256-bit data key (DEK). The payload is encrypted
 *    with AES-256-GCM under the DEK; the DEK is wrapped with AES-256-GCM under a root key
 *    identified by `keyId`.
 *  - Additional authenticated data (AAD) binds a ciphertext to its owner and purpose (e.g.
 *    integration + user), so a sealed value copied to another row fails to open.
 *  - Rotating the root key only requires re-wrapping DEKs; older keys stay in the keyring
 *    for decryption until re-wrapped. A managed KMS can replace `wrap`/`unwrap` later.
 *
 * Format (all base64url, dot-separated): v1.<keyId>.<wrapIv>.<wrappedDek>.<wrapTag>.<iv>.<ct>.<tag>
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface RootKey {
  id: string;
  key: Buffer;
}

export class Keyring {
  readonly current: RootKey;
  private readonly keys: Map<string, Buffer>;

  constructor(current: RootKey, previous: RootKey[] = []) {
    for (const k of [current, ...previous]) {
      if (!KEY_ID_RE.test(k.id)) throw new Error("Invalid root key id");
      if (k.key.length !== KEY_BYTES) throw new Error("Root keys must be 32 bytes");
    }
    this.current = current;
    this.keys = new Map([...previous, current].map((k) => [k.id, k.key]));
  }

  get(id: string): Buffer | undefined {
    return this.keys.get(id);
  }

  /** Parse `TOKEN_KEY_ID` + base64 key, plus optional `id:base64,id:base64` previous keys. */
  static fromConfig(input: { keyId: string; keyBase64: string; previous?: string }): Keyring {
    const decode = (b64: string) => Buffer.from(b64, "base64");
    const previous = (input.previous ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const i = entry.indexOf(":");
        if (i <= 0) throw new Error("Previous keys must be formatted as keyId:base64");
        return { id: entry.slice(0, i), key: decode(entry.slice(i + 1)) };
      });
    return new Keyring({ id: input.keyId, key: decode(input.keyBase64) }, previous);
  }
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

function gcmEncrypt(key: Buffer, plaintext: Buffer, aad: Buffer) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, ct, tag: cipher.getAuthTag() };
}

function gcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** Encrypt `plaintext`, bound to `aad`. Never log the inputs. */
export function seal(keyring: Keyring, plaintext: string, aad: string): string {
  const dek = randomBytes(KEY_BYTES);
  try {
    const keyId = keyring.current.id;
    const wrapped = gcmEncrypt(keyring.current.key, dek, Buffer.from(`${VERSION}:dek:${keyId}`));
    const body = gcmEncrypt(dek, Buffer.from(plaintext, "utf8"), Buffer.from(`${VERSION}:${aad}`));
    return [
      VERSION,
      keyId,
      b64(wrapped.iv),
      b64(wrapped.ct),
      b64(wrapped.tag),
      b64(body.iv),
      b64(body.ct),
      b64(body.tag),
    ].join(".");
  } finally {
    dek.fill(0);
  }
}

/** Decrypt a sealed value. Throws EnvelopeError if the key is unknown or anything was altered. */
export function open(keyring: Keyring, sealed: string, aad: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 8 || parts[0] !== VERSION)
    throw new EnvelopeError("Unsupported envelope format");
  const [, keyId, wIv, wCt, wTag, iv, ct, tag] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const root = keyring.get(keyId);
  if (!root) throw new EnvelopeError("Unknown root key id");
  let dek: Buffer | undefined;
  try {
    dek = gcmDecrypt(
      root,
      unb64(wIv),
      unb64(wCt),
      unb64(wTag),
      Buffer.from(`${VERSION}:dek:${keyId}`),
    );
    return gcmDecrypt(
      dek,
      unb64(iv),
      unb64(ct),
      unb64(tag),
      Buffer.from(`${VERSION}:${aad}`),
    ).toString("utf8");
  } catch (e) {
    if (e instanceof EnvelopeError) throw e;
    throw new EnvelopeError("Envelope authentication failed");
  } finally {
    dek?.fill(0);
  }
}

/** The root key id a sealed value was wrapped with (for rotation reporting). */
export function sealedKeyId(sealed: string): string | null {
  const parts = sealed.split(".");
  return parts.length === 8 && parts[0] === VERSION ? (parts[1] ?? null) : null;
}

/** Re-wrap under the keyring's current key without changing the payload's AAD binding. */
export function reseal(keyring: Keyring, sealed: string, aad: string): string {
  return seal(keyring, open(keyring, sealed, aad), aad);
}
