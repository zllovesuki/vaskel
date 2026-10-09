import { apiErrors } from "@vaskel/contracts/api";
import { type RequestIdVariables } from "hono/request-id";
import { type IdentityDependencies } from "./routes/identity";
import { Hono } from "hono";
import { ORPCError } from "@orpc/server";
import { requestId } from "hono/request-id";

import { createApplicationRouter } from "./routes/application";
import { createContractRouter } from "./http/contract-router";
import { handleAuthRequest } from "./auth/ingress";
import { createPublicInstanceRouter } from "./routes/instance";
import { createFileRouter } from "./routes/files";
import { logEvent } from "./telemetry";

type HttpEnvironment = {
  Bindings: Env;
  Variables: RequestIdVariables;
};

export function createHttpApp(
  options: { identity?: IdentityDependencies } = {},
) {
  const app = new Hono<HttpEnvironment>();

  app.use("*", requestId({ headerName: "CF-Ray", limitLength: 128 }));

  app.use("*", async (context, next) => {
    context.header("X-Request-ID", context.get("requestId"));
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Cache-Control", "no-store");
    await next();
  });

  app.route("/api", createPublicInstanceRouter());
  app.route("/api", createFileRouter());
  app.all("/api/auth/*", (context) =>
    handleAuthRequest(context.req.raw, context.env, context.get("requestId")),
  );
  app.route("/api", createContractRouter(options.identity));
  app.route("/api", createApplicationRouter());

  app.notFound((context) =>
    context.json(
      new ORPCError("NOT_FOUND", { defined: true, status: 404 }).toJSON(),
      404,
    ),
  );

  app.onError((error, context) => {
    if (error instanceof ORPCError)
      return new Response(
        JSON.stringify({
          ...error.toJSON(),
          defined: Object.hasOwn(apiErrors, error.code),
        }),
        {
          status: error.status,
          headers: {
            "Content-Type": "application/json",
            "X-Request-ID": context.get("requestId"),
            "Cache-Control": "no-store",
          },
        },
      );
    // Never log request bodies, cookies, authorization headers or raw exceptions.
    logEvent(
      "error",
      "request_failed",
      {
        requestId: context.get("requestId"),
        route: context.req.routePath,
      },
      error,
    );
    return context.json(new ORPCError("INTERNAL_SERVER_ERROR").toJSON(), 500);
  });

  return app;
}
