import type { Metadata, Viewport } from "next";
import "./globals.css";
import { serverEnv } from "@/lib/server-env";

export const metadata: Metadata = {
  title: "Scholar AI",
  description: "Approval-first academic planning from Google Tasks and Canvas context.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// Configuration is validated at request time on the server, never baked in at build time.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const env = serverEnv();
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {env.integrationsMode === "mock" ? (
          <div className="mock-banner" role="status" data-testid="mock-banner">
            Mock mode: synthetic fixture data only. Nothing here is connected to Google or Canvas.
          </div>
        ) : null}
        {children}
      </body>
    </html>
  );
}
