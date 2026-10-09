import { betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import type { AuthEnvironment } from "./environment";
import { authOrigin, trustedAuthOrigins } from "./environment";
import { identityDatabase, primaryAuthDatabase } from "./database";

export interface SessionCreationHooks {
  beforeSessionCreate?: () => Promise<void>;
}

/** Each request owns its auth context; sign-in also owns its captured credential epoch. */
export function createAuth(
  env: AuthEnvironment,
  hooks: SessionCreationHooks = {},
) {
  const origin = authOrigin(env);
  if (!origin) throw new Error("Authentication origin is not configured.");
  const db = primaryAuthDatabase(env);
  let signInEpoch: number | undefined;
  return betterAuth({
    appName: "vaskel.",
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.AUTH_SECRET,
    database: db,
    trustedOrigins: trustedAuthOrigins(env),
    user: {
      modelName: "identity_user",
      additionalFields: {
        authEpoch: {
          type: "number",
          required: true,
          defaultValue: 0,
          input: false,
          returned: false,
        },
      },
    },
    account: { modelName: "identity_account" },
    // Never written by vaskel., but the library's schema check requires the table.
    verification: { modelName: "identity_verification" },
    session: {
      modelName: "identity_session",
      expiresIn: 60 * 60 * 24 * 7,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        authEpoch: {
          type: "number",
          required: true,
          defaultValue: 0,
          input: false,
          returned: false,
        },
      },
    },
    // Only sign-in, sign-out and getSession are dispatched; password rules,
    // resets and verification tokens stay in vaskel.'s ingress and D1 batches.
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
    },
    // Worker ingress uses the configured Cloudflare rate limiter bindings.
    rateLimit: { enabled: false },
    logger: { disabled: true },
    advanced: {
      useSecureCookies: origin.startsWith("https:"),
      cookiePrefix: "vaskel",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
      database: {
        generateId: () => crypto.randomUUID(),
        joins: true,
        // The native auth-schema test validates the migration baseline before release.
        validateSchema: false,
      },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    hooks: {
      before: createAuthMiddleware(async (context) => {
        if (context.path !== "/sign-in/email") return;
        const email: unknown = context.body?.email;
        if (typeof email !== "string") return;
        const row = await identityDatabase(env)
          .selectFrom("identity_user")
          .select("authEpoch")
          .where("email", "=", email.toLowerCase())
          .executeTakeFirst();
        signInEpoch = row?.authEpoch;
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            if (signInEpoch === undefined) return false;
            await hooks.beforeSessionCreate?.();
            return { data: { ...session, authEpoch: signInEpoch } };
          },
        },
      },
    },
  });
}
