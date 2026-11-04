import { redirect } from "next/navigation";
import { DEMO_USERS } from "@scholar/db";
import { getSessionUser } from "@/lib/session";
import { serverEnv } from "@/lib/server-env";
import { SignInForm } from "@/components/sign-in-form";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  if (await getSessionUser()) redirect("/dashboard");
  const env = serverEnv();
  const demo = env.integrationsMode === "mock" && !env.isProduction;
  return (
    <main id="main">
      <h1>Sign in to Scholar AI</h1>
      <SignInForm
        demoUsers={demo ? DEMO_USERS.map((u) => ({ email: u.email, name: u.name })) : []}
        googleEnabled={env.google.signInConfigured}
      />
    </main>
  );
}
