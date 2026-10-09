import { readHttpFailure } from "@tests/helpers/http";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MessagingOutcomeSchema } from "@vaskel/contracts/messaging";
import { EXPECTED_ACCOUNT_HEADER } from "@vaskel/contracts/identity";
import { getPrincipal } from "@/server/auth/principal";
import {
  applicationHarness,
  applicationSocket,
  messageCommand,
} from "@tests/helpers/application-harness";

describe("room socket renewal HTTP authority", () => {
  it("renews the same authenticated connection and rejects replacement, revoked and mismatched-account sessions", async () => {
    const h = applicationHarness();
    const current = await h.bootstrap();
    const replacement = await h.signIn(h.client(), "operator@example.invalid");
    const server = await h.createServer(current);
    const ticket = MessagingOutcomeSchema.parse(
      await (
        await current.request(`${server.path}/socket-ticket`, {
          channelId: server.owner.id,
        })
      ).json(),
    );
    if (ticket.kind !== "socket_ticket") throw new Error(ticket.kind);
    const stream = await applicationSocket(
      await current.request(`${server.path}/socket`, undefined, {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": `vaskel-v1, vaskel-ticket.${ticket.ticket}`,
        },
      }),
    );
    const input = {
      channelId: server.owner.id,
      connectionId: stream.ready.connectionId,
    };
    const route = `${server.path}/socket-renew`;
    try {
      const renewed = await current.request(route, input);
      expect(renewed.status).toBe(200);
      expect(MessagingOutcomeSchema.parse(await renewed.json())).toMatchObject({
        kind: "socket_renewed",
        connectionId: input.connectionId,
      });
      const wrongSession = await replacement.request(route, input);
      expect(wrongSession.status).toBe(409);
      expect(await readHttpFailure(wrongSession)).toMatchObject({
        code: "SOCKET_UNAVAILABLE",
      });
      const wrongAccount = await current.request(route, input, {
        headers: { [EXPECTED_ACCOUNT_HEADER]: crypto.randomUUID() },
      });
      expect(wrongAccount.status).toBe(401);
      expect(
        (await current.request(route, { ...input, connectionId: "invalid" }))
          .status,
      ).toBe(400);
      const identity = await getPrincipal(
        new Request(`${env.AUTH_ORIGIN}/api/identity/me`, {
          headers: { Cookie: current.cookie },
        }),
        env,
      );
      if (!identity) throw new Error("Missing identity");
      // Delete identity authority without delivering any inbox revocation hint.
      await env.IDENTITY_DB.prepare("DELETE FROM identity_session WHERE id = ?")
        .bind(identity.sessionId)
        .run();
      expect((await current.request(route, input)).status).toBe(401);
      const owner = env.SERVER_DO.getByName(server.owner.id);
      await runInDurableObject(owner, (_instance, state) => {
        const connection = state.getWebSockets()[0]!;
        connection.serializeAttachment({
          ...connection.deserializeAttachment(),
          leaseExpiresAt: 0,
        });
      });
      // Actual owner delivery still enforces the lease even without an inbox signal.
      expect(
        (
          await replacement.request(
            `${server.path}/send`,
            messageCommand(server.owner.id),
          )
        ).status,
      ).toBe(200);
      expect(await stream.next()).toEqual({ type: "lease_expired" });
    } finally {
      await stream.close();
    }
  });
});
