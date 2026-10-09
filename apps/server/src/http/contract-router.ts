import type { IdentityDependencies } from "@/server/routes/identity";
import type { RequestIdVariables } from "hono/request-id";
import { ORPCError, onError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import {
  apiContract,
  identityApiContract,
  mediaApiContract,
} from "@vaskel/contracts/api";
import { contract } from "./procedures";
import { messageProcedures } from "@/server/routes/resource-contract";
import { administrationProcedures } from "@/server/routes/administration";
import { directoryProcedures } from "@/server/routes/directory";
import { activityProcedures } from "@/server/routes/activity";
import { preferencesProcedures } from "@/server/routes/preferences";
import { presenceProcedures } from "@/server/routes/presence";
import { searchProcedures } from "@/server/routes/search";
import { blockProcedures } from "@/server/routes/blocks";
import { notificationProcedures } from "@/server/routes/notifications";
import { accountEventProcedures } from "@/server/routes/account-events";
import { attachmentProcedures } from "@/server/routes/attachments";
import { instanceProcedures } from "@/server/routes/instance";
import { invitationProcedures } from "@/server/routes/invitations";
import { identityHandlers } from "@/server/routes/identity";
import { accountHandlers } from "@/server/routes/account";
import { mediaProcedures } from "@/server/routes/media";
import { identityThrottle } from "@/server/auth/ingress";
import {
  authConfigured,
  requestOriginAllowed,
} from "@/server/auth/environment";
import { logEvent } from "@/server/telemetry";

const router = contract.router({
  ...messageProcedures,
  ...administrationProcedures,
  ...directoryProcedures,
  ...activityProcedures,
  ...preferencesProcedures,
  ...presenceProcedures,
  ...searchProcedures,
  ...blockProcedures,
  ...notificationProcedures,
  ...accountEventProcedures,
  ...attachmentProcedures,
  ...instanceProcedures,
  ...invitationProcedures,
  ...identityHandlers,
  ...accountHandlers,
  ...mediaProcedures,
});
const handler = new OpenAPIHandler(router, {
  clientInterceptors: [
    onError((error, { context, path }) => {
      if (!(error instanceof ORPCError) || error.status >= 500)
        logEvent(
          "error",
          "request_failed",
          { requestId: context.requestId, route: path.join(".") },
          error,
        );
    }),
  ],
});
// Address budgets run before parsing credential bodies. Account actions have user budgets.
const identityActions = new Map<string, "sign-in" | "mail" | "bootstrap">([
  ["signIn", "sign-in"],
  ["bootstrap", "bootstrap"],
  ["requestPasswordReset", "mail"],
  ["resendVerification", "mail"],
  ["resetPassword", "sign-in"],
  ["operatorPasswordReset", "mail"],
]);
export function createContractRouter(
  identityDependencies: IdentityDependencies = {},
) {
  const app = new Hono<{ Bindings: Env; Variables: RequestIdVariables }>();
  for (const [name, procedure] of Object.entries(apiContract)) {
    const route = procedure["~orpc"].route;
    if (!route.path || !route.method)
      throw new Error("HTTP operation requires a route");
    const path = route.path.replace(/\{(\w+)\}/g, ":$1");
    const maxSize = Object.hasOwn(mediaApiContract, name)
      ? 2 * 1024 * 1024
      : Object.hasOwn(identityApiContract, name)
        ? 8192
        : 256 * 1024;
    app.on(
      route.method,
      path,
      async (context, next) => {
        const action = identityActions.get(name);
        if (action) {
          if (!authConfigured(context.env))
            throw new ORPCError("UNAVAILABLE", { status: 503 });
          if (!requestOriginAllowed(context.req.raw, context.env))
            throw new ORPCError("ORIGIN_REJECTED", { status: 403 });
          if (!(await identityThrottle(context.req.raw, context.env, action)))
            throw new ORPCError("RATE_LIMITED", { status: 429 });
        }
        await next();
      },
      bodyLimit({
        maxSize,
        onError: () => {
          throw new ORPCError("PAYLOAD_TOO_LARGE");
        },
      }),
      async (context) => {
        const responseHeaders = new Headers({
          "Cache-Control": "private, no-store",
        });
        const result = await handler.handle(context.req.raw, {
          prefix: "/api",
          context: {
            env: context.env,
            request: context.req.raw,
            requestId: context.get("requestId"),
            responseHeaders,
            executionCtx: {
              waitUntil: (work) => context.executionCtx.waitUntil(work),
            },
            identityDependencies,
          },
        });
        if (!result.matched) throw new Error("Contract route did not match");
        const response = context.newResponse(
          result.response.body,
          result.response,
        );
        responseHeaders.forEach((value, key) => {
          if (key !== "set-cookie") response.headers.set(key, value);
        });
        for (const cookie of responseHeaders.getSetCookie())
          response.headers.append("Set-Cookie", cookie);
        return response;
      },
    );
  }
  return app;
}
