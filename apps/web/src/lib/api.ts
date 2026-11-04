import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createLogger } from "@scholar/security";
import { serverEnv } from "./server-env";
import { getSessionUser, type SessionUser } from "./session";
import { isSameOriginRequest } from "./csrf";
import { checkRateLimit } from "./rate-limit";

const logger = createLogger({ service: "web" });

export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "csrf_rejected"
  | "not_found"
  | "conflict"
  | "invalid_request"
  | "capability_unavailable"
  | "rate_limited"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  csrf_rejected: 403,
  not_found: 404,
  conflict: 409,
  invalid_request: 422,
  capability_unavailable: 403,
  rate_limited: 429,
  internal_error: 500,
};

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export const notFound = () => new ApiError("not_found", "Not found");

export function jsonData(data: unknown, requestId: string, status = 200) {
  return NextResponse.json(
    { data, requestId },
    { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } },
  );
}

function jsonError(e: ApiError, requestId: string) {
  return NextResponse.json(
    { error: { code: e.code, message: e.message, retryable: e.retryable }, requestId },
    { status: STATUS[e.code], headers: { "x-request-id": requestId, "cache-control": "no-store" } },
  );
}

export const uuidSchema = z.uuid();

/** Parse a route id; malformed ids are indistinguishable from absent ones. */
export function parseId(raw: string): string {
  const r = uuidSchema.safeParse(raw);
  if (!r.success) throw notFound();
  return r.data;
}

export interface HandlerContext {
  req: Request;
  user: SessionUser;
  requestId: string;
}

interface RouteOptions {
  /** Mutations require same-origin and JSON bodies. */
  mutation?: boolean;
  rateLimit?: { bucket: string; limit: number; windowMs: number };
}

/**
 * Wrap an authenticated API route: session auth, CSRF origin check for mutations, per-user
 * rate limits, safe error envelopes, and request IDs. Ownership is enforced inside each
 * handler by passing `ctx.user.id` to owner-scoped repositories.
 */
export function apiRoute<P = Record<string, string>>(
  options: RouteOptions,
  handler: (ctx: HandlerContext, params: P) => Promise<Response>,
) {
  return async (req: Request, routeCtx: { params: Promise<P> }): Promise<Response> => {
    const requestId = randomUUID();
    try {
      const env = serverEnv();
      if (options.mutation) {
        if (!isSameOriginRequest(req.headers, env.appOrigin)) {
          throw new ApiError("csrf_rejected", "Cross-origin request rejected");
        }
      }
      const user = await getSessionUser(req.headers);
      if (!user) throw new ApiError("unauthenticated", "Sign in required");
      const limit =
        options.rateLimit ??
        (options.mutation
          ? { bucket: "mutation", limit: 60, windowMs: 60_000 }
          : { bucket: "read", limit: 300, windowMs: 60_000 });
      if (!checkRateLimit(`${user.id}:${limit.bucket}`, limit.limit, limit.windowMs)) {
        throw new ApiError("rate_limited", "Too many requests", true);
      }
      const params = (await routeCtx.params) ?? ({} as P);
      return await handler({ req, user, requestId }, params);
    } catch (e) {
      if (e instanceof ApiError) return jsonError(e, requestId);
      logger.error("api.unhandled", { requestId, errorName: (e as Error)?.name, error: e });
      return jsonError(new ApiError("internal_error", "Something went wrong", true), requestId);
    }
  };
}

/** Parse a JSON body against a schema; rejects non-JSON content types. */
export async function readJson<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new ApiError("invalid_request", "Expected application/json");
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new ApiError("invalid_request", "Malformed JSON");
  }
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new ApiError(
      "invalid_request",
      r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  return r.data;
}
