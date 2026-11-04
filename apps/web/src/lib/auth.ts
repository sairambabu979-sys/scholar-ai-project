import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { serverEnv } from "./server-env";
import { db } from "./db";

function createAuth() {
  const env = serverEnv();
  const demoSignIn = env.integrationsMode === "mock" && !env.isProduction;
  return betterAuth({
    appName: "Scholar AI",
    baseURL: env.appUrl,
    secret: env.authSecret,
    trustedOrigins: [env.appOrigin],
    database: prismaAdapter(db(), { provider: "postgresql" }),
    advanced: {
      cookiePrefix: "scholar",
      useSecureCookies: env.isProduction,
      database: { generateId: "uuid" },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },
    rateLimit: { enabled: true, window: 60, max: 30 },
    // Synthetic demo accounts exist only in non-production mock mode. No self sign-up.
    emailAndPassword: { enabled: demoSignIn, disableSignUp: true },
    // Application sign-in requests identity scopes only. Google Tasks access is a separate,
    // later grant (Phase 2) and never piggybacks on sign-in.
    socialProviders: env.google.signInConfigured
      ? {
          google: {
            clientId: env.google.clientId!,
            clientSecret: env.google.clientSecret!,
            redirectURI: env.google.authRedirectUri,
            scope: ["openid", "email", "profile"],
          },
        }
      : {},
    account: {
      encryptOAuthTokens: true,
      accountLinking: { enabled: false },
    },
    user: {
      additionalFields: {
        timezone: { type: "string", required: false, defaultValue: "UTC", input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const allowed = env.authAllowedEmails;
            const email = String(user.email ?? "").toLowerCase();
            if (allowed.length > 0 && !allowed.includes(email)) {
              throw new APIError("FORBIDDEN", { message: "This account is not allowed" });
            }
            return { data: user };
          },
        },
      },
    },
    plugins: [nextCookies()],
  });
}

type Auth = ReturnType<typeof createAuth>;
const globalForAuth = globalThis as unknown as { __scholarAuth?: Auth };

export function auth(): Auth {
  if (!globalForAuth.__scholarAuth) globalForAuth.__scholarAuth = createAuth();
  return globalForAuth.__scholarAuth;
}
