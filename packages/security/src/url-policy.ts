/**
 * Outbound URL policy for institution-hosted services such as Canvas (SCHOLAR_AI_PLAN.md §5):
 * HTTPS only, configured origins only, no credentials in URLs, and every resolved address must
 * be a public unicast address — loopback, private, link-local, cloud-metadata, CGNAT, unique
 * local, multicast, documentation and translation ranges are refused, for IPv4 and IPv6
 * (including IPv4-mapped/NAT64/6to4/Teredo forms that could smuggle an internal IPv4 address).
 */
import net from "node:net";

const v4Rules = new net.BlockList();
for (const [prefix, len] of [
  ["0.0.0.0", 8], // "this network", unspecified
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local incl. 169.254.169.254 metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  v4Rules.addSubnet(prefix, len, "ipv4");
}

function parseIPv6(addr: string): number[] | null {
  let a = addr.toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  if (!net.isIPv6(a)) return null;
  // Embedded dotted IPv4 tail (e.g. ::ffff:127.0.0.1).
  const lastColon = a.lastIndexOf(":");
  const tail = a.slice(lastColon + 1);
  let tailWords: number[] = [];
  if (tail.includes(".")) {
    const o = tail.split(".").map(Number);
    tailWords = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!];
    a = a.slice(0, lastColon + 1) + "0:0";
  }
  const [head, rest] = a.includes("::") ? a.split("::") : [a, undefined];
  const h = head ? head.split(":").filter((x) => x !== "") : [];
  const r = rest !== undefined && rest !== "" ? rest.split(":") : [];
  const fill = rest === undefined ? 0 : 8 - h.length - r.length;
  const words = [...h, ...Array(fill).fill("0"), ...r].map((x) => parseInt(x, 16));
  if (words.length !== 8 || words.some((w) => Number.isNaN(w))) return null;
  if (tailWords.length) {
    words[6] = tailWords[0]!;
    words[7] = tailWords[1]!;
  }
  return words;
}

const v4FromWords = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

/** True when connecting to `ip` must be refused. Unparseable input is refused. */
export function isDisallowedAddress(ip: string): boolean {
  if (net.isIPv4(ip)) return v4Rules.check(ip, "ipv4");
  const w = parseIPv6(ip);
  if (!w) return true;
  const allZero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
  if (allZero(0, 8)) return true; // ::
  if (allZero(0, 7) && w[7] === 1) return true; // ::1
  if (allZero(0, 5) && w[5] === 0xffff) return isDisallowedAddress(v4FromWords(w[6]!, w[7]!)); // IPv4-mapped
  if (allZero(0, 6)) return true; // deprecated IPv4-compatible
  if (w[0] === 0x64 && w[1] === 0xff9b) return true; // NAT64
  if (w[0] === 0x2002) return true; // 6to4
  if (w[0] === 0x2001 && w[1] === 0) return true; // Teredo
  if (w[0] === 0x2001 && w[1] === 0xdb8) return true; // documentation
  if (w[0] === 0x100 && allZero(1, 4)) return true; // discard-only
  const first = w[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local (incl. fd00:ec2::254)
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export class UrlPolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "UrlPolicyError";
  }
}

/** Validate an origin configured for an institution service (e.g. CANVAS_BASE_URL). */
export function normalizeServiceOrigin(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UrlPolicyError("invalid_url");
  }
  if (u.protocol !== "https:") throw new UrlPolicyError("https_required");
  if (u.username || u.password) throw new UrlPolicyError("credentials_in_url");
  if (u.port && u.port !== "443") throw new UrlPolicyError("non_default_port");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash)
    throw new UrlPolicyError("origin_only");
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) throw new UrlPolicyError("ip_literal_host");
  if (!u.hostname.includes(".")) throw new UrlPolicyError("single_label_host");
  return u.origin;
}

/** Throws unless `url` is https and on one of `allowedOrigins` (exact origin match). */
export function assertAllowedUrl(url: string, allowedOrigins: readonly string[]): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new UrlPolicyError("invalid_url");
  }
  if (u.protocol !== "https:") throw new UrlPolicyError("https_required");
  if (u.username || u.password) throw new UrlPolicyError("credentials_in_url");
  if (!allowedOrigins.includes(u.origin)) throw new UrlPolicyError("origin_not_allowed");
  return u;
}
