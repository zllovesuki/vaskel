import type {
  IdentityFailure,
  IdentityProfile,
} from "@vaskel/contracts/identity";
import type { AuthEnvironment } from "./environment";
import type { SessionCreationHooks } from "./library";
import type { IdentityPrincipal } from "./principal";
import { revokeAccountEvents } from "./event-revocation";

import {
  IdentityMeResponseSchema,
  SignOutResponseSchema,
  EXPECTED_ACCOUNT_HEADER,
} from "@vaskel/contracts/identity";

import {
  authConfigured,
  authOrigin,
  requestOriginAllowed,
} from "./environment";
import { privateFingerprint } from "./crypto";
import { createAuth } from "./library";

import { getPrincipal } from "./principal";

import { outcomeResponse } from "@/server/http/orpc";
import { ORPCError } from "@orpc/server";
import { readAccountPreferences } from "./preferences";

export async function publicProfile(
  principal: IdentityPrincipal,
  env: AuthEnvironment,
): Promise<IdentityProfile> {
  return {
    userId: principal.userId,
    displayName: principal.displayName,
    email: principal.email,
    isOperator: principal.isOperator,
    expiresAt: new Date(principal.expiresAt).toISOString(),
    preferences: await readAccountPreferences(env, principal.userId),
  };
}

export async function identityThrottle(
  request: Request,
  env: AuthEnvironment,
  action: "sign-in" | "mail" | "bootstrap",
): Promise<boolean> {
  const limiter =
    action === "sign-in" ? env.AUTH_RATE_LIMITER : env.SENSITIVE_RATE_LIMITER;
  const key = await privateFingerprint(
    env.AUTH_SECRET,
    `${action}:${request.headers.get("CF-Connecting-IP") ?? "local"}`,
  );
  return (await limiter.limit({ key })).success;
}

/** Routine account reads never spend the IP budget that protects sign-in. */
export async function accountThrottle(
  env: AuthEnvironment,
  userId: string,
  action: "read" | "manage" | "password",
): Promise<boolean> {
  const limiter =
    action === "password" ? env.SENSITIVE_RATE_LIMITER : env.AUTH_RATE_LIMITER;
  const key = await privateFingerprint(
    env.AUTH_SECRET,
    `account:${action}:${userId}`,
  );
  return (await limiter.limit({ key })).success;
}

function identityExchange<T extends { status: string }>(
  outcome: T,
  response?: Response,
) {
  return { outcome, cookies: response?.headers.getSetCookie() ?? [] };
}

export async function signInIdentity(
  request: Request,
  env: AuthEnvironment,
  input: { email: string; password: string },
  hooks: SessionCreationHooks = {},
) {
  const auth = createAuth(env, hooks);
  const authRequest = new Request(`${authOrigin(env)}/api/auth/sign-in/email`, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify({
      email: input.email,
      password: input.password,
    }),
  });
  const response = await auth.handler(authRequest);
  if (!response.ok) {
    if (response.status >= 500)
      throw new Error("Authentication infrastructure failed.");
    const raw: unknown = await response.json();
    const code =
      raw !== null && typeof raw === "object" && "code" in raw
        ? raw.code
        : undefined;
    const failure: IdentityFailure = {
      status:
        code === "EMAIL_NOT_VERIFIED"
          ? "email_unverified"
          : "invalid_credentials",
    };
    return identityExchange(failure, response);
  }
  // Never put the bearer token returned by the library into application JSON.
  const cookieHeaders = new Headers(request.headers);
  cookieHeaders.set(
    "Cookie",
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; "),
  );
  const principal = await getPrincipal(
    new Request(request.url, { headers: cookieHeaders }),
    env,
    { identityPrecondition: false },
  );
  if (!principal)
    return identityExchange({ status: "unauthenticated" }, response);
  return identityExchange(
    IdentityMeResponseSchema.parse({
      status: "authenticated",
      user: await publicProfile(principal, env),
    }),
    response,
  );
}

export async function signOutIdentity(request: Request, env: AuthEnvironment) {
  // Local teardown may finish after another tab signed in. Never revoke or
  // clear the replacement cookie for another account.
  const correlated = request.headers.has(EXPECTED_ACCOUNT_HEADER);
  const principal = await getPrincipal(request, env);
  if (correlated && !principal)
    return identityExchange({ status: "unauthenticated" });
  const response = await createAuth(env).handler(
    new Request(`${authOrigin(env)}/api/auth/sign-out`, {
      method: "POST",
      headers: request.headers,
      body: "{}",
    }),
  );
  // A delayed response must not clear a cookie installed after dispatch either.
  // Revocation makes the original cookie unusable without rewriting a newer one.
  const cookieResponse = correlated ? undefined : response;
  if (!response.ok) {
    if (response.status >= 500)
      throw new Error("Authentication infrastructure failed.");
    return identityExchange({ status: "unauthenticated" }, cookieResponse);
  }
  if (principal)
    await revokeAccountEvents(env, principal.userId, {
      kind: "session",
      sessionId: principal.sessionId,
      expiresAt: principal.expiresAt,
    });
  return identityExchange(
    SignOutResponseSchema.parse({ status: "signed_out" }),
    cookieResponse,
  );
}

/** Public Better Auth routes cannot create accounts or issue alternate tokens. */
export async function handleAuthRequest(
  request: Request,
  env: AuthEnvironment,
  requestId?: string,
): Promise<Response> {
  if (!authConfigured(env)) return outcomeResponse({ status: "unavailable" });
  if (!requestOriginAllowed(request, env))
    return Response.json(
      new ORPCError("ORIGIN_REJECTED", { defined: true, status: 403 }).toJSON(),
      {
        status: 403,
        headers: {
          "X-Request-ID": requestId ?? crypto.randomUUID(),
          "Cache-Control": "no-store",
        },
      },
    );
  return outcomeResponse({ status: "forbidden" });
}
