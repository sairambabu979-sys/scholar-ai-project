import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  /** Server-side session id; OAuth transactions are bound to it. */
  sessionId: string;
}

/** The authenticated user, or null. The user ID always comes from the server session. */
export async function getSessionUser(requestHeaders?: Headers): Promise<SessionUser | null> {
  const session = await auth().api.getSession({ headers: requestHeaders ?? (await headers()) });
  if (!session?.user) return null;
  return {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    sessionId: session.session.id,
  };
}

/** For server components/pages: redirect to sign-in when unauthenticated. */
export async function requirePageUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/sign-in");
  return user;
}
