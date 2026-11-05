import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { loadEnvFiles } from "@scholar/config/load-env";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
// Single env file at the repository root (.env.local), shared with the worker and Prisma.
loadEnvFiles(repoRoot);

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  {
    key: "Content-Security-Policy",
    // Script nonces arrive with production hardening (Phase 7); these directives already
    // block framing, plugins, base-tag hijacking and off-site form posts.
    value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'",
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Do not let the framework write agent instruction files into the repository.
  agentRules: false,
  poweredByHeader: false,
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  transpilePackages: [
    "@scholar/config",
    "@scholar/db",
    "@scholar/domain",
    "@scholar/integrations",
    "@scholar/security",
    "@scholar/services",
  ],
  serverExternalPackages: ["pg"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
