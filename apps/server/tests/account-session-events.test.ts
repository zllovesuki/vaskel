import { eventDispatchStub } from "@/server/event-dispatch/routing";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ListSessionsResponseSchema } from "@vaskel/contracts/account";
import { SignInResponseSchema } from "@vaskel/contracts/identity";
import { applicationHarness } from "@tests/helpers/application-harness";
import {
  accountEventsTicket,
  openAccountEvents,
} from "@tests/helpers/event-dispatch-harness";
import { getPrincipal } from "@/server/auth/principal";
import { actorPrincipal } from "@/server/directory/owners";
import { attachment } from "@/server/actors/event-dispatch/sockets";
import {
  replacementPassword,
  testPassword,
} from "@tests/helpers/identity-harness";

async function signInAfterChange(h: ReturnType<typeof applicationHarness>) {
  const client = h.client();
  const response = await client.request("/api/identity/sign-in", {
    email: "operator@example.invalid",
    password: replacementPassword,
  });
  const result = SignInResponseSchema.parse(await response.json());
  if (result.status !== "authenticated") throw new Error(result.status);
  client.profile = result.user;
  client.cookie = response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  return client;
}

describe("account session mutations revoke inbox transport after identity commit", () => {
  it.each([false, true])(
    "preserves retained cookies while fencing ended sockets (revoke others: %s)",
    async (revokeOtherSessions) => {
      const h = applicationHarness();
      const current = await h.bootstrap();
      const other = await h.signIn(h.client(), "operator@example.invalid");
      const currentInbox = await openAccountEvents(current);
      const otherInbox = await openAccountEvents(other);
      const pendingTicket = await accountEventsTicket(current);
      const inbox = eventDispatchStub(env, current.profile!.userId);
      const before = await runInDurableObject(inbox, (_instance, state) =>
        state.getWebSockets().map(attachment),
      );
      const changed = await current.request("/api/identity/change-password", {
        currentPassword: testPassword,
        newPassword: replacementPassword,
        revokeOtherSessions,
      });
      expect(changed.status).toBe(200);
      expect((await current.request("/api/identity/me")).status).toBe(200);
      if (revokeOtherSessions) {
        await otherInbox.closed;
        await currentInbox.sync();
        expect(
          currentInbox.frames.some((frame) => frame.type === "revoked"),
        ).toBe(false);
        const after = await runInDurableObject(inbox, (_instance, state) =>
          state
            .getWebSockets()
            .filter((socket) => socket.readyState === WebSocket.OPEN)
            .map(attachment),
        );
        expect(after).toHaveLength(1);
        expect(after[0]).toEqual({
          ...before.find((value) => value?.sessionId === after[0]?.sessionId),
          authEpoch: 1,
        });
        // Even the retained session must obtain a new ticket for a new socket.
        const staleUpgrade = await current.request(
          "/api/account/events",
          undefined,
          {
            headers: {
              Upgrade: "websocket",
              "Sec-WebSocket-Protocol": `vaskel-account-events-v1, vaskel-ticket.${pendingTicket.ticket}`,
            },
          },
        );
        expect(staleUpgrade.status).toBe(403);
        expect(
          (await other.request("/api/account/events/ticket", {})).status,
        ).toBe(401);
        const owner = { kind: "server" as const, id: crypto.randomUUID() };
        await inbox.deliver({
          recipients: [current.profile!.userId],
          notice: { type: "directory", owner },
        });
        await currentInbox.sync();
        expect(currentInbox.frames).toContainEqual({
          type: "directory",
          owner,
        });
        // A delayed duplicate must also leave a later login at the new epoch alone.
        const fresh = await signInAfterChange(h);
        const freshInbox = await openAccountEvents(fresh);
        await inbox.revoke(current.profile!.userId, {
          kind: "epoch",
          minimumAuthEpoch: 1,
          preserveSessionId: after[0]!.sessionId,
        });
        await Promise.all([currentInbox.sync(), freshInbox.sync()]);
        expect(
          freshInbox.frames.some((frame) => frame.type === "revoked"),
        ).toBe(false);
        await freshInbox.close();
        await currentInbox.close();
      } else {
        await currentInbox.sync();
        await otherInbox.sync();
        expect((await other.request("/api/identity/me")).status).toBe(200);
        await currentInbox.close();
        await otherInbox.close();
      }
    },
  );

  it.each(["reset", "session"] as const)(
    "does not revive a retained session after a newer %s revocation",
    async (endedBy) => {
      const h = applicationHarness();
      const current = await h.bootstrap();
      const identity = await getPrincipal(
        new Request(`${env.AUTH_ORIGIN}/api/identity/me`, {
          headers: { Cookie: current.cookie },
        }),
        env,
      );
      if (!identity) throw new Error("Missing identity");
      const inbox = eventDispatchStub(env, identity.userId);
      const stream = await openAccountEvents(current);
      expect(
        (
          await current.request("/api/identity/change-password", {
            currentPassword: testPassword,
            newPassword: replacementPassword,
            revokeOtherSessions: true,
          })
        ).status,
      ).toBe(200);
      await stream.sync();
      if (endedBy === "reset") {
        await h.anonymous.request("/api/identity/request-password-reset", {
          email: "operator@example.invalid",
        });
        expect(
          (
            await h.anonymous.request("/api/identity/reset-password", {
              token: h.mailer.token("reset_password"),
              password: replacementPassword,
            })
          ).status,
        ).toBe(200);
      } else {
        expect(
          (
            await current.request("/api/identity/revoke-session", {
              sessionId: identity.sessionId,
            })
          ).status,
        ).toBe(200);
      }
      await stream.closed;
      const fresh = await signInAfterChange(h);
      const freshInbox = await openAccountEvents(fresh);
      await inbox.revoke(identity.userId, {
        kind: "epoch",
        minimumAuthEpoch: 1,
        preserveSessionId: identity.sessionId,
      });
      expect(
        await inbox.prepareSocket({
          ...actorPrincipal(identity),
          sessionExpiresAt: identity.expiresAt,
          authEpoch: 1,
        }),
      ).toEqual({ kind: "unauthenticated" });
      expect(
        (await current.request("/api/account/events/ticket", {})).status,
      ).toBe(401);
      await freshInbox.sync();
      expect(freshInbox.frames.some((frame) => frame.type === "revoked")).toBe(
        false,
      );
      expect(stream.client.readyState).toBe(WebSocket.CLOSED);
      await freshInbox.close();
    },
  );

  it("closes targeted session inboxes, refuses later tickets and stays online until the final session is revoked", async () => {
    const h = applicationHarness();
    const current = await h.bootstrap();
    const other = await h.signIn(h.client(), "operator@example.invalid");
    const streams = await Promise.all([
      openAccountEvents(current),
      openAccountEvents(other),
    ]);
    const inbox = eventDispatchStub(env, current.profile!.userId);
    async function online() {
      const result = await inbox.samplePresence([current.profile!.userId]);
      if (result.kind !== "presence_samples") throw new Error(result.kind);
      return result.samples[0]!.state === "online";
    }
    try {
      expect(await online()).toBe(true);
      const listed = ListSessionsResponseSchema.parse(
        await (await current.request("/api/identity/sessions")).json(),
      );
      if (listed.status !== "sessions") throw new Error(listed.status);
      const retained = listed.sessions.find((session) => session.current)!;
      const ended = listed.sessions.find((session) => !session.current)!;
      expect(
        (
          await current.request("/api/identity/revoke-session", {
            sessionId: ended.id,
          })
        ).status,
      ).toBe(200);
      await streams[1]!.closed;
      expect(
        (await other.request("/api/account/events/ticket", {})).status,
      ).toBe(401);
      await streams[0]!.sync();
      expect(await online()).toBe(true);
      expect(
        (
          await current.request("/api/identity/revoke-session", {
            sessionId: retained.id,
          })
        ).status,
      ).toBe(200);
      await streams[0]!.closed;
      expect(await online()).toBe(false);
      expect(
        (await current.request("/api/account/events/ticket", {})).status,
      ).toBe(401);
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
    }
  });
});
