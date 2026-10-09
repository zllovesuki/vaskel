import type { MiddlewareHandler } from "hono";
import type { ApplicationEnvironment } from "./context";
import { ORPCError } from "@orpc/server";

import {
  authConfigured,
  requestOriginAllowed,
} from "@/server/auth/environment";
import { getPrincipal } from "@/server/auth/principal";
import { privateFingerprint } from "@/server/auth/crypto";
import { knownOwner } from "@/server/directory/owners";

export const requireApplicationOrigin: MiddlewareHandler<
  ApplicationEnvironment
> = async (context, next) => {
  if (!authConfigured(context.env))
    throw new ORPCError("UNAVAILABLE", { status: 503 });
  if (!requestOriginAllowed(context.req.raw, context.env))
    throw new ORPCError("ORIGIN_REJECTED", { status: 403 });
  await next();
};

export const requirePrincipal: MiddlewareHandler<
  ApplicationEnvironment
> = async (context, next) => {
  const principal = await getPrincipal(context.req.raw, context.env);
  if (!principal) throw new ORPCError("UNAUTHENTICATED", { status: 401 });
  context.set("principal", principal);
  await next();
};

/** Owner routes conceal unknown or pending owners before any body is read. */
export function requireKnownOwner({
  kind,
  unknown = "not_found",
}: {
  kind?: "server";
  unknown?: "not_found" | "source_unavailable";
} = {}): MiddlewareHandler<ApplicationEnvironment> {
  return async (context, next) => {
    const owner = await knownOwner(
      context.env,
      kind ?? context.req.param("kind"),
      context.req.param("id"),
      context.get("directorySession"),
    );
    if (!owner)
      throw new ORPCError(unknown.toUpperCase(), {
        status: unknown === "not_found" ? 404 : 409,
      });
    context.set("owner", owner);
    await next();
  };
}

export async function allowApplicationRequest(
  env: Env,
  key: string,
  scope: "application" | "invite" = "application",
): Promise<boolean> {
  const fingerprint = await privateFingerprint(env.AUTH_SECRET, key);
  const limiter =
    scope === "invite" ? env.INVITE_RATE_LIMITER : env.APPLICATION_RATE_LIMITER;
  return (await limiter.limit({ key: fingerprint })).success;
}
