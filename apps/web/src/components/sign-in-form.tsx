"use client";
import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

const noopSubscribe = () => () => {};

export function SignInForm(props: {
  demoUsers: Array<{ email: string; name: string }>;
  googleEnabled: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState(props.demoUsers[0]?.email ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Submitting before hydration would fall back to a native form submit; wait for React.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

  async function demoSignIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (err) {
      setError(
        err.status === 429
          ? "Too many sign-in attempts. Wait a few seconds and try again."
          : "Sign-in failed. Check the demo password in the README.",
      );
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  async function googleSignIn() {
    setBusy(true);
    await authClient.signIn.social({ provider: "google", callbackURL: "/dashboard" });
  }

  return (
    <div className="stack">
      {props.googleEnabled ? (
        <section className="card">
          <h2>Google account</h2>
          <p className="muted small">
            Sign-in requests only your basic profile (OpenID). Google Tasks access is a separate
            permission you grant later.
          </p>
          <button type="button" onClick={googleSignIn} disabled={busy || !hydrated}>
            Continue with Google
          </button>
        </section>
      ) : null}
      {props.demoUsers.length > 0 ? (
        <section className="card" aria-labelledby="demo-heading">
          <h2 id="demo-heading">
            Demo student <span className="badge mock">mock mode</span>
          </h2>
          <p className="muted small">
            Synthetic local accounts created by <code>npm run db:seed:demo</code>. Not available in
            live mode or production.
          </p>
          <form onSubmit={demoSignIn}>
            <div className="field">
              <label htmlFor="demo-email">Demo account</label>
              <select id="demo-email" value={email} onChange={(e) => setEmail(e.target.value)}>
                {props.demoUsers.map((u) => (
                  <option key={u.email} value={u.email}>
                    {u.name} ({u.email})
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="demo-password">Demo password</label>
              <input
                id="demo-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <button type="submit" disabled={busy || !hydrated}>
              Sign in as demo student
            </button>
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        </section>
      ) : null}
      {!props.googleEnabled && props.demoUsers.length === 0 ? (
        <p className="notice">No sign-in method is configured. See the README.</p>
      ) : null}
    </div>
  );
}
