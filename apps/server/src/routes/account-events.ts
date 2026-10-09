import { rawRoutes } from "@vaskel/contracts/api";
import { Hono } from "hono";
import { eventDispatchStub } from "@/server/event-dispatch/routing";
import { applicationRead } from "@/server/http/procedures";
import { expectedOutcome } from "@/server/http/orpc";
import { actorPrincipal } from "@/server/directory/owners";
import type { ApplicationEnvironment } from "@/server/http/context";
export const accountEventProcedures = {
  accountEventTicket: applicationRead.accountEventTicket.handler(
    async ({ context }) =>
      expectedOutcome(
        await eventDispatchStub(
          context.env,
          context.principal.userId,
        ).prepareSocket({
          ...actorPrincipal(context.principal),
          sessionExpiresAt: context.principal.expiresAt,
          authEpoch: context.principal.authEpoch,
        }),
        "event_ticket",
      ),
  ),
};
export function createAccountEventsRouter() {
  const app = new Hono<ApplicationEnvironment>();
  app.get(rawRoutes.accountSocket.path.slice(4), async (context) => {
    const principal = context.get("principal");
    const headers = new Headers(context.req.raw.headers);
    headers.delete("Cookie");
    headers.delete("Authorization");
    headers.set("X-Vaskel-User-Id", principal.userId);
    headers.set("X-Vaskel-Session-Id", principal.sessionId);
    headers.set("X-Vaskel-Auth-Epoch", String(principal.authEpoch));
    headers.set("X-Vaskel-Session-Expires-At", String(principal.expiresAt));
    return eventDispatchStub(context.env, principal.userId).fetch(
      new Request(context.req.raw, { headers }),
    );
  });
  return app;
}
