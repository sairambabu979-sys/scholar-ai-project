import Link from "next/link";
import { requirePageUser } from "@/lib/session";
import { SignOutButton } from "@/components/sign-out-button";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePageUser();
  return (
    <>
      <header className="site-header">
        <Link href="/dashboard" className="brand">
          Scholar AI
        </Link>
        <nav aria-label="Main">
          <Link href="/dashboard">Dashboard</Link>
          <Link href="/onboarding">Setup</Link>
          <Link href="/settings">Settings</Link>
          <span className="small muted" data-testid="signed-in-as">
            {user.name}
          </span>
          <SignOutButton />
        </nav>
      </header>
      <main id="main">{children}</main>
    </>
  );
}
