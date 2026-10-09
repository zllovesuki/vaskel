import type { IdentityDependencies } from "@/server/routes/identity";
import type { IdentityPrincipal } from "@/server/auth/principal";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import { implement, os, ORPCError } from "@orpc/server";
import { apiContract, type ApiMeta } from "@vaskel/contracts/api";

import { getPrincipal } from "@/server/auth/principal";
import {
  authConfigured,
  requestOriginAllowed,
} from "@/server/auth/environment";
import { knownOwner } from "@/server/directory/owners";
import { createDirectorySession } from "@/server/directory/database";
import { allowApplicationRequest } from "./access";

export interface Ingress {
  env: Env;
  request: Request;
  requestId: string;
  responseHeaders: Headers;
  executionCtx: Pick<ExecutionContext, "waitUntil">;
  identityDependencies: IdentityDependencies;
}
const middleware = os.$context<Ingress>().$meta<ApiMeta>({
  authority: "public",
  freshness: "account",
});
export const origin = middleware.middleware(async ({ context, next }) => {
  if (!authConfigured(context.env))
    throw new ORPCError("UNAVAILABLE", { status: 503 });
  if (!requestOriginAllowed(context.request, context.env))
    throw new ORPCError("ORIGIN_REJECTED", { status: 403 });
  return next();
});
export const authenticated = middleware.middleware(
  async ({ context, next }) => {
    const principal = await getPrincipal(context.request, context.env);
    if (!principal) throw new ORPCError("UNAUTHENTICATED", { status: 401 });
    return next({ context: { principal } });
  },
);
export const directorySession = (primary: boolean) =>
  middleware.middleware(async ({ context, next }) => {
    const { session } = createDirectorySession(
      context.env,
      context.request.headers.get("X-Vaskel-D1-Bookmark") ?? undefined,
      primary,
    );
    try {
      return await next({ context: { directorySession: session } });
    } finally {
      const bookmark = session.getBookmark();
      if (bookmark)
        context.responseHeaders.set("X-Vaskel-D1-Bookmark", bookmark);
    }
  });
const privateMiddleware = middleware.$context<
  Ingress & { principal: IdentityPrincipal }
>();
export const applicationBudget = privateMiddleware.middleware(
  async ({ context, next }) => {
    if (
      !(await allowApplicationRequest(
        context.env,
        `application:${context.principal.userId}`,
      ))
    )
      throw new ORPCError("CAPACITY", {
        status: 429,
        data: { kind: "capacity" },
      });
    return next();
  },
);
export const operator = privateMiddleware.middleware(
  async ({ context, next }) => {
    if (!context.principal.isOperator)
      throw new ORPCError("FORBIDDEN", { status: 403 });
    return next({
      context: {
        principal: { ...context.principal, isOperator: true as const },
      },
    });
  },
);
export const resolveOwner = middleware
  .$context<
    Ingress & {
      principal: IdentityPrincipal;
      directorySession: D1DatabaseSession;
    }
  >()
  .middleware(async ({ context, next }, scope: OwnerScope) => {
    const owner = await knownOwner(
      context.env,
      scope.kind,
      scope.id,
      context.directorySession,
    );
    if (!owner) throw new ORPCError("NOT_FOUND", { status: 404 });
    return next({ context: { owner } });
  });
export const contract = implement(apiContract).$context<Ingress>();
export const identityProcedures = contract.use(origin);
export const privateProcedures = identityProcedures.use(authenticated);
const application = privateProcedures.use(applicationBudget);
export const applicationRead = application.use(directorySession(false));
export const applicationPrimary = application.use(directorySession(true));

/** Primary identity is rechecked where an operation releases data after external work. */
export async function freshPrincipal(
  context: Ingress & { principal: IdentityPrincipal },
) {
  const fresh = await getPrincipal(context.request, context.env);
  if (
    !fresh ||
    fresh.userId !== context.principal.userId ||
    fresh.sessionId !== context.principal.sessionId
  )
    throw new ORPCError("UNAUTHENTICATED", { status: 401 });
  return fresh;
}
