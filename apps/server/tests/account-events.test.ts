import { readHttpFailure } from "@tests/helpers/http";
import { eventDispatchStub } from "@/server/event-dispatch/routing";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ACCOUNT_EVENTS_LEASE_MS } from "@vaskel/contracts/account-events";
import { AdministrationOutcomeSchema } from "@vaskel/contracts/administration";
import { DirectoryOutcomeSchema } from "@vaskel/contracts/resources";
import { MessagingOutcomeSchema } from "@vaskel/contracts/messaging";
import { getPrincipal } from "@/server/auth/principal";
import { actorPrincipal } from "@/server/directory/owners";
import type { EventDispatchPrincipal } from "@/server/actors/event-dispatch/store";
import {
  applicationHarness,
  applicationSocket,
  messageCommand,
  resourcePath,
  type ApplicationClient,
} from "@tests/helpers/application-harness";
import {
  accountEventsSocket,
  accountEventsTicket,
  openAccountEvents,
} from "@tests/helpers/event-dispatch-harness";
import { testPassword } from "@tests/helpers/identity-harness";
import { ResourceCreatedSchema } from "@vaskel/contracts/directory";
import { NotificationOutcomeSchema } from "@vaskel/contracts/notifications";
import { blockCommand } from "@tests/helpers/blocking-harness";

async function principal(
  client: ApplicationClient,
): Promise<EventDispatchPrincipal> {
  const identity = await getPrincipal(
    new Request(`${env.AUTH_ORIGIN}/api/account/events`, {
      headers: { Cookie: client.cookie },
    }),
    env,
  );
  if (!identity) throw new Error("Fixture session missing.");
  return {
    ...actorPrincipal(identity),
    sessionExpiresAt: identity.expiresAt,
    authEpoch: identity.authEpoch,
  };
}
function upgradeHeaders(ticket: string) {
  return {
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": `vaskel-account-events-v1, vaskel-ticket.${ticket}`,
  };
}
function privateUpgrade(p: EventDispatchPrincipal, ticket: string) {
  return new Request("https://vaskel.test/private-inbox", {
    headers: {
      ...upgradeHeaders(ticket),
      "X-Vaskel-User-Id": p.userId,
      "X-Vaskel-Session-Id": p.sessionId,
      "X-Vaskel-Auth-Epoch": String(p.authEpoch),
      "X-Vaskel-Session-Expires-At": String(p.sessionExpiresAt),
    },
  });
}
async function outcome(response: Response) {
  expect(response.status).toBe(200);
  return MessagingOutcomeSchema.parse(await response.json());
}

describe("account inbox HTTP and hibernating actor", () => {
  it("binds single-use tickets to the primary-backed session, enforces origin and frames, and keeps the actual session lifetime", async () => {
    const h = applicationHarness();
    const client = await h.bootstrap();
    const p = await principal(client);
    const ticket = await accountEventsTicket(client);
    expect(ticket.leaseExpiresAt).toBeGreaterThan(p.expiresAt + 60_000);
    expect(ticket.leaseExpiresAt).toBeLessThanOrEqual(
      Date.now() + ACCOUNT_EVENTS_LEASE_MS,
    );
    expect(
      (await h.anonymous.request("/api/account/events/ticket", {})).status,
    ).toBe(401);
    expect(
      (
        await client.request(
          "/api/account/events/ticket",
          {},
          { origin: "https://untrusted.invalid" },
        )
      ).status,
    ).toBe(403);
    const other = await h.signIn(h.client(), "operator@example.invalid");
    expect(
      (
        await other.request("/api/account/events", undefined, {
          headers: upgradeHeaders(ticket.ticket),
        })
      ).status,
    ).toBe(403);
    const stream = await accountEventsSocket(
      await client.request("/api/account/events", undefined, {
        headers: {
          ...upgradeHeaders(ticket.ticket),
          "X-Vaskel-User-Id": "forged",
          "X-Vaskel-Session-Id": "forged",
          "X-Vaskel-Auth-Epoch": "999",
          "X-Vaskel-Session-Expires-At": "1",
        },
      }),
    );
    expect(stream.ready).toEqual({
      type: "ready",
      resync: true,
      leaseExpiresAt: ticket.leaseExpiresAt,
    });
    expect(
      (
        await client.request("/api/account/events", undefined, {
          headers: upgradeHeaders(ticket.ticket),
        })
      ).status,
    ).toBe(403);
    stream.client.send('{"type":"ping"}');
    expect(await stream.next()).toEqual({ type: "pong" });
    stream.client.send('{"type":"focus","owner":null,"channelId":null}');
    expect((await stream.closed).code).toBe(1008);

    const shortExpiry = Date.now() + 20_000;
    await env.IDENTITY_DB.prepare(
      "UPDATE identity_session SET expiresAt=? WHERE id=?",
    )
      .bind(new Date(shortExpiry).toISOString(), p.sessionId)
      .run();
    const short = await accountEventsTicket(client);
    expect(short.leaseExpiresAt).toBe(shortExpiry);
    await env.IDENTITY_DB.prepare(
      "UPDATE identity_session SET expiresAt=? WHERE id=?",
    )
      .bind(new Date(Date.now() - 1_000).toISOString(), p.sessionId)
      .run();
    expect(
      (
        await client.request("/api/account/events", undefined, {
          headers: upgradeHeaders(short.ticket),
        })
      ).status,
    ).toBe(401);
  });

  it("emits only fresh, authorized activity; mutations and private reads are distinct hints", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const alice = await h.registerMember(operator, server.owner.id);
    const bob = await h.registerMember(
      operator,
      server.owner.id,
      "bob@example.invalid",
      "Bob",
    );
    const channelId = crypto.randomUUID();
    const directory = (await operator
      .request(server.path)
      .then((r) => r.json())) as { version: number };
    const created = AdministrationOutcomeSchema.parse(
      await (
        await operator.request(`/api/servers/${server.owner.id}/channels`, {
          channelId,
          name: "Private",
          private: true,
          expectedVersion: directory.version,
        })
      ).json(),
    );
    expect(created.kind).toBe("changed");
    expect(
      (
        await operator.request(
          `/api/servers/${server.owner.id}/channel-member`,
          {
            channelId,
            userId: alice.registered.userId,
            allowed: true,
            expectedVersion: 1,
          },
        )
      ).status,
    ).toBe(200);
    const streams = await Promise.all([
      openAccountEvents(operator),
      openAccountEvents(alice.member),
      openAccountEvents(bob.member),
    ]);
    const [own, allowed, denied] = streams;
    try {
      const command = messageCommand(
        channelId,
        "Private content must never enter the inbox.",
      );
      const sent = await outcome(
        await operator.request(`${server.path}/send`, command),
      );
      if (sent.kind !== "accepted") throw new Error(sent.kind);
      expect(
        await outcome(await operator.request(`${server.path}/send`, command)),
      ).toEqual(sent);
      await Promise.all(streams.map((s) => s.sync()));
      await expect
        .poll(() => allowed!.frames.filter((n) => n.type === "activity"))
        .toHaveLength(1);
      const activity = allowed!.frames.filter((n) => n.type === "activity");
      expect(activity).toHaveLength(1);
      expect(activity[0]).toMatchObject({
        type: "activity",
        owner: server.owner,
        channelId,
        sequence: sent.receipt.sequence,
      });
      expect(JSON.stringify(activity)).not.toContain(command.body);
      expect(own!.frames.filter((n) => n.type === "activity")).toHaveLength(0);
      expect(denied!.frames.filter((n) => n.type === "activity")).toHaveLength(
        0,
      );
      const edit = {
        ...messageCommand(channelId, "Edited private content"),
        messageId: sent.receipt.messageId,
        expectedVersion: 1,
      };
      const edited = await outcome(
        await operator.request(`${server.path}/edit`, edit),
      );
      expect(
        await outcome(await operator.request(`${server.path}/edit`, edit)),
      ).toEqual(edited);
      await outcome(
        await alice.member.request(`${server.path}/read`, {
          channelId,
          sequence: sent.receipt.sequence,
        }),
      );
      await Promise.all(streams.map((s) => s.sync()));
      await expect
        .poll(() => allowed!.frames.filter((n) => n.type === "mutation"))
        .toHaveLength(1);
      await expect
        .poll(() => own!.frames.filter((n) => n.type === "mutation"))
        .toHaveLength(1);
      await expect
        .poll(() => allowed!.frames.find((n) => n.type === "read"))
        .toMatchObject({
          owner: server.owner,
          channelId,
          generation: activity[0]!.generation,
          sequence: sent.receipt.sequence,
        });
      expect(own!.frames.some((n) => n.type === "read")).toBe(false);
      expect(
        denied!.frames.some((n) => n.type === "mutation" || n.type === "read"),
      ).toBe(false);
      await operator.request(`/api/servers/${server.owner.id}/channel-member`, {
        channelId,
        userId: alice.registered.userId,
        allowed: false,
        expectedVersion: 2,
      });
      await outcome(
        await operator.request(
          `${server.path}/send`,
          messageCommand(channelId, "After removal"),
        ),
      );
      await Promise.all(streams.map((s) => s.sync()));
      expect(allowed!.frames.filter((n) => n.type === "activity")).toHaveLength(
        1,
      );
      expect(allowed!.frames.some((n) => n.type === "directory")).toBe(true);
    } finally {
      await Promise.all(streams.map((s) => s.close()));
    }
  });

  it("tells each reader whether a new message addresses them and announces settings changes", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const alice = await h.registerMember(operator, server.owner.id);
    const bob = await h.registerMember(
      operator,
      server.owner.id,
      "bob@example.invalid",
      "Bob",
    );
    const aliceId = alice.registered.userId;
    const streams = await Promise.all([
      openAccountEvents(operator),
      openAccountEvents(alice.member),
      openAccountEvents(bob.member),
    ]);
    const [own, addressed, other] = streams;
    const settle = () => Promise.all(streams.map((stream) => stream.sync()));
    const arrival = (
      stream: (typeof streams)[number],
      owner: { kind: string; id: string },
      sequence: number,
    ) =>
      stream.frames.find(
        (frame) =>
          frame.type === "activity" &&
          frame.owner.id === owner.id &&
          frame.sequence === sequence,
      );
    try {
      const mention = await outcome(
        await operator.request(
          `${server.path}/send`,
          messageCommand(server.channelId, `Private [](/mentions/${aliceId})`),
        ),
      );
      if (mention.kind !== "accepted") throw new Error(mention.kind);
      const sequence = mention.receipt.sequence;
      await expect
        .poll(
          async () => (
            await settle(),
            arrival(addressed, server.owner, sequence)
          ),
        )
        .toMatchObject({ direct: true });
      await expect
        .poll(
          async () => (await settle(), arrival(other, server.owner, sequence)),
        )
        .toMatchObject({ direct: false });
      expect(arrival(own, server.owner, sequence)).toBeUndefined();
      expect(JSON.stringify(addressed.frames)).not.toContain("Private");

      // Replying with a quote addresses the quoted author, and only them.
      const reply = await outcome(
        await bob.member.request(`${server.path}/send`, {
          ...messageCommand(server.channelId, "Reply"),
          quote: {
            owner: server.owner,
            channelId: server.channelId,
            messageId: mention.receipt.messageId,
          },
        }),
      );
      if (reply.kind !== "accepted") throw new Error(reply.kind);
      await expect
        .poll(
          async () => (
            await settle(),
            arrival(own, server.owner, reply.receipt.sequence)
          ),
        )
        .toMatchObject({ direct: true });
      await expect
        .poll(
          async () => (
            await settle(),
            arrival(addressed, server.owner, reply.receipt.sequence)
          ),
        )
        .toMatchObject({ direct: false });

      const created = ResourceCreatedSchema.parse(
        await (
          await operator.request("/api/conversations", { userId: aliceId })
        ).json(),
      );
      if (created.kind !== "created") throw new Error(created.kind);
      const dm = await outcome(
        await operator.request(
          `${resourcePath(created.owner)}/send`,
          messageCommand(created.channelId, "Are you around?"),
        ),
      );
      if (dm.kind !== "accepted") throw new Error(dm.kind);
      await expect
        .poll(
          async () => (
            await settle(),
            arrival(addressed, created.owner, dm.receipt.sequence)
          ),
        )
        .toMatchObject({ direct: true, owner: created.owner });

      // A confirmed settings change reaches the account's own clients only.
      const state = NotificationOutcomeSchema.parse(
        await (await alice.member.request("/api/notifications")).json(),
      );
      if (state.kind !== "notification_state") throw new Error(state.kind);
      const paused = NotificationOutcomeSchema.parse(
        await (
          await alice.member.request("/api/notifications/commands", {
            kind: "preferences",
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
            expectedRevision: state.state.revision,
            ...state.state.preferences,
            paused: true,
          })
        ).json(),
      );
      expect(paused.kind).toBe("notification_updated");
      await expect
        .poll(
          async () => (
            await settle(),
            addressed.frames.filter(
              (frame) => frame.type === "notification_settings",
            )
          ),
        )
        .toEqual([{ type: "notification_settings" }]);
      await settle();
      for (const stream of [own, other])
        expect(
          stream.frames.some((frame) => frame.type === "notification_settings"),
        ).toBe(false);
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
    }
  });

  it("revokes exactly one session durably, including outstanding and delayed tickets", async () => {
    const h = applicationHarness();
    const client = await h.bootstrap();
    const other = await h.signIn(h.client(), "operator@example.invalid");
    const stale = await principal(client);
    const inbox = eventDispatchStub(env, stale.userId);
    const first = await openAccountEvents(client);
    const second = await openAccountEvents(other);
    const pending = await accountEventsTicket(client);
    expect((await client.request("/api/identity/sign-out", {})).status).toBe(
      200,
    );
    expect(await first.next()).toEqual({ type: "revoked" });
    expect((await first.closed).code).toBe(4001);
    await second.sync();
    expect(second.frames.some((n) => n.type === "revoked")).toBe(false);
    expect(await inbox.prepareSocket(stale)).toEqual({
      kind: "unauthenticated",
    });
    const denied = await inbox.fetch(privateUpgrade(stale, pending.ticket));
    expect(denied.status).toBe(403);
    await denied.text();
    await second.close();
    await evictDurableObject(inbox, { webSockets: "close" });
    expect(await inbox.prepareSocket(stale)).toEqual({
      kind: "unauthenticated",
    });
  });

  it("fences password-reset epochs without revoking a later login when invalidation is delayed", async () => {
    const h = applicationHarness();
    const client = await h.bootstrap();
    const old = await principal(client);
    const inbox = eventDispatchStub(env, old.userId);
    const stream = await openAccountEvents(client);
    const ticket = await accountEventsTicket(client);
    expect(
      (
        await h.anonymous.request("/api/identity/reset-password", {
          token: "invalid",
          password: testPassword,
        })
      ).status,
    ).toBe(400);
    await stream.sync();
    expect(stream.frames.some((n) => n.type === "revoked")).toBe(false);
    await h.anonymous.request("/api/identity/request-password-reset", {
      email: "operator@example.invalid",
    });
    expect(
      (
        await h.anonymous.request("/api/identity/reset-password", {
          token: h.mailer.token("reset_password"),
          password: testPassword,
        })
      ).status,
    ).toBe(200);
    expect(await stream.next()).toEqual({ type: "revoked" });
    await stream.closed;
    const fresh = await h.signIn(h.client(), "operator@example.invalid");
    const p = await principal(fresh);
    expect(p.authEpoch).toBe(old.authEpoch + 1);
    const current = await openAccountEvents(fresh);
    try {
      await inbox.revoke(old.userId, {
        kind: "epoch",
        minimumAuthEpoch: p.authEpoch,
      });
      await current.sync();
      expect(current.frames.some((n) => n.type === "revoked")).toBe(false);
      expect(await inbox.prepareSocket(old)).toEqual({
        kind: "unauthenticated",
      });
      expect(
        (await inbox.fetch(privateUpgrade(old, ticket.ticket))).status,
      ).toBe(403);
    } finally {
      await current.close();
    }
  });

  it("caps concurrent upgrades at eight and expires sockets without losing ticket deadlines", async () => {
    const h = applicationHarness();
    const client = await h.bootstrap();
    const p = await principal(client);
    const inbox = eventDispatchStub(env, p.userId);
    const tickets = await Promise.all(
      Array.from({ length: 8 }, () => accountEventsTicket(client)),
    );
    expect(
      await readHttpFailure(
        await client.request("/api/account/events/ticket", {}),
      ),
    ).toMatchObject({ code: "CAPACITY" });
    const streams = await Promise.all(
      tickets.map((t) =>
        inbox.fetch(privateUpgrade(p, t.ticket)).then(accountEventsSocket),
      ),
    );
    try {
      expect(await inbox.prepareSocket(p)).toEqual({ kind: "capacity" });
      await runInDurableObject(inbox, (_instance, state) => {
        for (const socket of state.getWebSockets()) {
          const value = socket.deserializeAttachment() as {
            leaseExpiresAt: number;
          };
          socket.serializeAttachment({
            ...value,
            leaseExpiresAt: Date.now() - 1,
          });
        }
      });
      await runInDurableObject(inbox, (instance) => instance.alarm());
      for (const stream of streams) {
        expect(await stream.next()).toEqual({ type: "lease_expired" });
        await stream.closed;
      }
      const ticket = await accountEventsTicket(client);
      await runInDurableObject(inbox, (_instance, state) => {
        state.storage.sql.exec(
          "UPDATE dispatch_tickets SET expires_at=?",
          Date.now() - 1,
        );
      });
      await runInDurableObject(inbox, (instance) => instance.alarm());
      expect((await inbox.fetch(privateUpgrade(p, ticket.ticket))).status).toBe(
        403,
      );
    } finally {
      await Promise.all(streams.map((s) => s.close()));
    }
  });
  it("keeps block-only pairs hidden and invalidates directory and existing DM policy", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const { member } = await h.registerMember(operator, server.owner.id);
    const first = await openAccountEvents(operator);
    const second = await openAccountEvents(member);
    try {
      const blockPath = `/api/account/blocks/${member.profile!.userId}`;
      expect(
        (await operator.request(blockPath, blockCommand(), { method: "PUT" }))
          .status,
      ).toBe(200);
      await Promise.all([first.sync(), second.sync()]);
      expect(first.frames.some((n) => n.type === "dm_policy")).toBe(false);
      expect(second.frames.some((n) => n.type === "dm_policy")).toBe(false);
      const created = ResourceCreatedSchema.parse(
        await (
          await operator.request("/api/conversations", {
            userId: member.profile!.userId,
          })
        ).json(),
      );
      if (created.kind !== "created") throw new Error(created.kind);
      expect(
        (
          await operator.request(blockPath, blockCommand(false, 1), {
            method: "PUT",
          })
        ).status,
      ).toBe(200);
      await Promise.all([first.sync(), second.sync()]);
      for (const stream of [first, second]) {
        await expect
          .poll(() => stream.frames)
          .toContainEqual({
            type: "directory",
            owner: created.owner,
          });
        await expect
          .poll(() => stream.frames)
          .toContainEqual({
            type: "dm_policy",
            owner: created.owner,
          });
      }
      const beforeMetadata = second.frames.filter(
        (n) => n.type === "directory",
      ).length;
      const current = DirectoryOutcomeSchema.parse(
        await (await operator.request(server.path)).json(),
      );
      if (current.kind !== "directory") throw new Error(current.kind);
      expect(
        (
          await operator.request(`/api/servers/${server.owner.id}/rename`, {
            name: "Renamed circle",
            expectedVersion: current.version,
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await operator.request(`/api/servers/${server.owner.id}/rename`, {
            name: "Stale rename",
            expectedVersion: current.version,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await operator.request(
            `/api/servers/${server.owner.id}/update-channel`,
            {
              channelId: server.channelId,
              name: "Renamed room",
              topic: "Updated room topic",
              position: 0,
              expectedVersion: current.channels[0]!.version,
            },
          )
        ).status,
      ).toBe(200);
      await second.sync();
      await expect
        .poll(() => second.frames.filter((n) => n.type === "directory").length)
        .toBeGreaterThanOrEqual(beforeMetadata + 2);
      const directory = DirectoryOutcomeSchema.parse(
        await (await operator.request(server.path)).json(),
      );
      if (directory.kind !== "directory") throw new Error(directory.kind);
      expect(directory).toMatchObject({
        name: "Renamed circle",
        channels: [{ name: "Renamed room", topic: "Updated room topic" }],
      });
      expect(
        (
          await operator.request(
            `/api/servers/${server.owner.id}/remove-member`,
            {
              userId: member.profile!.userId,
              expectedVersion: directory.version,
            },
          )
        ).status,
      ).toBe(200);
      await second.sync();
      expect(second.frames).toContainEqual({
        type: "directory",
        owner: server.owner,
      });
      expect((await member.request(server.path)).status).toBe(403);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("keeps an HTTP Send and its receipt accepted when its target hub fails", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const alice = await h.registerMember(operator, server.owner.id);
    const stream = await openAccountEvents(alice.member);
    const hub = eventDispatchStub(env, alice.registered.userId);
    const ticket = await outcome(
      await alice.member.request(`${server.path}/socket-ticket`, {
        channelId: server.channelId,
      }),
    );
    if (ticket.kind !== "socket_ticket") throw new Error(ticket.kind);
    const room = await applicationSocket(
      await alice.member.request(`${server.path}/socket`, undefined, {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": `vaskel-v1, vaskel-ticket.${ticket.ticket}`,
        },
      }),
    );
    const failedDelivery = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    await runInDurableObject(hub, (_instance, state) => {
      // Break the real eligibility query while keeping the native RPC method intact.
      state.storage.sql.exec(
        "ALTER TABLE dispatch_accounts RENAME TO fixture_unavailable_accounts",
      );
    });
    try {
      const command = messageCommand(
        server.channelId,
        "Committed through hub outage",
      );
      const accepted = await outcome(
        await operator.request(`${server.path}/send`, command),
      );
      expect(accepted.kind).toBe("accepted");
      await expect
        .poll(() =>
          failedDelivery.mock.calls.some(
            ([entry]) =>
              typeof entry === "object" &&
              entry !== null &&
              "event" in entry &&
              entry.event === "event_hint_delivery_failed" &&
              "actorId" in entry &&
              entry.actorId ===
                env.SERVER_DO.idFromName(server.owner.id).toString(),
          ),
        )
        .toBe(true);
      await expect
        .poll(() => room.frames.some((frame) => frame.type === "committed"))
        .toBe(true);
      expect(
        await outcome(await operator.request(`${server.path}/send`, command)),
      ).toEqual(accepted);
      const snapshot = await outcome(
        await operator.request(`${server.path}/snapshot`, {
          channelId: server.channelId,
        }),
      );
      if (snapshot.kind !== "snapshot") throw new Error(snapshot.kind);
      expect(snapshot.messages.map((message) => message.body)).toEqual([
        command.body,
      ]);
      await stream.sync();
      expect(stream.frames.some((frame) => frame.type === "activity")).toBe(
        false,
      );
    } finally {
      await runInDurableObject(hub, (_instance, state) => {
        state.storage.sql.exec(
          "ALTER TABLE fixture_unavailable_accounts RENAME TO dispatch_accounts",
        );
      });
      failedDelivery.mockRestore();
      await Promise.all([stream.close(), room.close()]);
    }
  });

  it("publishes no account hint for a rolled-back command", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    const alice = await h.registerMember(operator, server.owner.id);
    const bob = await h.registerMember(
      operator,
      server.owner.id,
      "bob@example.invalid",
      "Bob",
    );
    const background = createExecutionContext();
    const cleanup: (() => void)[] = [];
    const actors = [
      env.SERVER_DO.getByName(server.owner.id),
      ...[
        ...new Set(
          [alice.registered.userId, bob.registered.userId].map((id) =>
            eventDispatchStub(env, id).id.toString(),
          ),
        ),
      ].map((id) =>
        env.EVENT_DISPATCH.get(env.EVENT_DISPATCH.idFromString(id)),
      ),
    ];
    for (const actor of actors)
      await runInDurableObject(actor, (_, state) => {
        const native = state.waitUntil.bind(state);
        const observer = vi
          .spyOn(state, "waitUntil")
          .mockImplementation((work) => {
            native(work);
            background.waitUntil(work);
          });
        cleanup.push(() => observer.mockRestore());
      });
    const first = await openAccountEvents(alice.member);
    const second = await openAccountEvents(bob.member);
    const owner = env.SERVER_DO.getByName(server.owner.id);
    try {
      const sent = await outcome(
        await operator.request(
          `${server.path}/send`,
          messageCommand(server.channelId, "Committed before rollback"),
        ),
      );
      expect(sent.kind).toBe("accepted");
      await Promise.all([first.sync(), second.sync()]);
      await expect
        .poll(() => first.frames.filter((n) => n.type === "activity"))
        .toHaveLength(1);
      await expect
        .poll(() => second.frames.filter((n) => n.type === "activity"))
        .toHaveLength(1);
      await runInDurableObject(owner, (_instance, state) => {
        state.storage.sql.exec(
          "CREATE TRIGGER fail_receipt BEFORE INSERT ON command_receipts BEGIN SELECT RAISE(ABORT, 'injected receipt rollback'); END",
        );
      });
      const rejected = await operator.request(
        `${server.path}/send`,
        messageCommand(server.channelId, "Must roll back"),
      );
      expect(rejected.status).toBe(500);
      await rejected.text();
      await Promise.all([first.sync(), second.sync()]);
      await expect
        .poll(() => first.frames.filter((n) => n.type === "activity"))
        .toHaveLength(1);
      expect(second.frames.filter((n) => n.type === "activity")).toHaveLength(
        1,
      );
      const snapshot = await outcome(
        await operator.request(`${server.path}/snapshot`, {
          channelId: server.channelId,
        }),
      );
      if (snapshot.kind !== "snapshot") throw new Error(snapshot.kind);
      expect(snapshot.messages.map((m) => m.body)).toEqual([
        "Committed before rollback",
      ]);
    } finally {
      await Promise.all([first.close(), second.close()]);
      // Await close reconciliation before draining its recursively emitted owner hints.
      for (const id of [alice.registered.userId, bob.registered.userId])
        await runInDurableObject(
          eventDispatchStub(env, id),
          async (_, state) => {
            await state.storage.transaction(async () => {
              expect(
                state.storage.sql
                  .exec(
                    "SELECT online FROM dispatch_accounts WHERE user_id=?",
                    id,
                  )
                  .one(),
              ).toEqual({ online: 0 });
            });
          },
        );
      try {
        await waitOnExecutionContext(background);
      } finally {
        for (const restore of cleanup) restore();
      }
    }
  });
});
