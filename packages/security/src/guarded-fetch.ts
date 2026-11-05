/**
 * fetch for configured institution hosts. The origin allowlist is checked before every request
 * (including pagination URLs), redirects are never followed (a 3xx is an error, so a bearer
 * token can never be forwarded elsewhere), and DNS answers are validated inside the socket's
 * lookup — at connect time — so a hostname cannot pass a check and then resolve to an internal
 * address (DNS rebinding).
 */
import dns from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";
import { assertAllowedUrl, isDisallowedAddress, UrlPolicyError } from "./url-policy.ts";

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** A `dns.lookup`-compatible function that refuses disallowed addresses. */
export function createGuardedLookup(resolve: Resolver = systemResolver) {
  return (
    hostname: string,
    options: LookupOptions | number | undefined,
    callback: LookupCallback,
  ) => {
    const opts: LookupOptions = typeof options === "number" ? { family: options } : (options ?? {});
    resolve(hostname)
      .then((addresses) => {
        const usable = addresses.filter((a) => !opts.family || a.family === opts.family);
        if (usable.length === 0) throw new UrlPolicyError("no_address");
        // Refuse if ANY answer is internal: a mixed answer set is a rebinding signal.
        if (addresses.some((a) => isDisallowedAddress(a.address)))
          throw new UrlPolicyError("address_not_allowed");
        if (opts.all) callback(null, usable);
        else callback(null, usable[0]!.address, usable[0]!.family);
      })
      .catch((e: unknown) => {
        const err = (e instanceof Error ? e : new Error(String(e))) as NodeJS.ErrnoException;
        callback(err, opts.all ? [] : "", undefined);
      });
  };
}

export type GuardedFetch = (url: string, init: RequestInit) => Promise<Response>;

export function createGuardedFetch(opts: {
  allowedOrigins: readonly string[];
  resolve?: Resolver;
  connectTimeoutMs?: number;
}): GuardedFetch {
  const agent = new Agent({
    connect: {
      lookup: createGuardedLookup(opts.resolve),
      timeout: opts.connectTimeoutMs ?? 10_000,
    },
  });
  return async (url, init) => {
    assertAllowedUrl(url, opts.allowedOrigins);
    const res = await undiciFetch(url, {
      ...(init as Record<string, unknown>),
      redirect: "manual",
      dispatcher: agent,
    } as Parameters<typeof undiciFetch>[1]);
    if (res.status >= 300 && res.status < 400) throw new UrlPolicyError("redirect_refused");
    return res as unknown as Response;
  };
}
