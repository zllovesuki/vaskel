import { rawRoutes } from "@vaskel/contracts/api";
import { Hono } from "hono";
import { actorPrincipal } from "@/server/directory/owners";
import type { ApplicationEnvironment } from "@/server/http/context";
export function createResourceRouter() {
  const app = new Hono<ApplicationEnvironment>();
  app.get(
    rawRoutes.roomSocket.path.slice(4).replace(/\{(\w+)\}/g, ":$1"),
    (context) => {
      const principal = context.get("principal");
      const headers = new Headers(context.req.raw.headers);
      headers.delete("Cookie");
      headers.delete("Authorization");
      headers.set("X-Vaskel-User-Id", principal.userId);
      headers.set("X-Vaskel-Session-Id", principal.sessionId);
      headers.set(
        "X-Vaskel-Assertion-Expires-At",
        String(actorPrincipal(principal).expiresAt),
      );
      return context
        .get("owner")
        .stub.fetch(new Request(context.req.raw, { headers }));
    },
  );
  return app;
}
