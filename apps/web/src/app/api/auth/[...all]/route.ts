import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

const handlers = () => toNextJsHandler(auth());

export async function GET(req: Request) {
  return handlers().GET(req);
}

export async function POST(req: Request) {
  return handlers().POST(req);
}
