import { readHttpFailure } from "@tests/helpers/http";
import { acceptedMessage as receipt } from "@tests/helpers/messaging";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  alice,
  bob,
  server,
  send,
  inviteMember,
  socket,
} from "@tests/helpers/messaging-owner";

describe("hibernating event producer and bounded authorization leases", () => {
  it("consumes protocol tickets once and produces executable ready, committed, reconcile and private read frames", async () => {
    const { id, owner } = await server();
    await inviteMember(owner);
    const stream = await socket(owner, id);
    const other = await socket(owner, id, bob());
    const retryUpgrade = await owner.fetch(stream.request());
    expect(retryUpgrade.status).toBe(403);
    await retryUpgrade.text();
    const sent = stream.next();
    const received = other.next();
    receipt((await owner.send(alice(), send(id))).outcome);
    expect((await sent).type).toBe("committed");
    expect((await received).type).toBe("committed");
    const read = stream.next();
    expect(
      await owner.updateRead(alice(), { channelId: id, sequence: 1 }),
    ).toEqual({ kind: "read_updated", sequence: 1 });
    expect(await read).toEqual({
      type: "read_updated",
      channelId: id,
      sequence: 1,
    });
    const reconciliation = other.next();
    other.client.send('{"type":"reconcile"}');
    expect(await reconciliation).toMatchObject({
      type: "reconcile",
      cursor: { sequence: 1 },
    });
    expect(other.frames.some((frame) => frame.type === "read_updated")).toBe(
      false,
    );
    stream.client.close();
    other.client.close();
  });

  it("rejects expired forwarded identity without consuming its still-live ticket", async () => {
    const { id, owner } = await server();
    const member = alice();
    const prepared = await owner.prepareSocket(member, { channelId: id });
    if (prepared.kind !== "socket_ticket") throw new Error("Expected ticket");
    const rejected = await owner.fetch(
      new Request("https://vaskel.test/events", {
        headers: {
          Upgrade: "websocket",
          "X-Vaskel-User-Id": member.userId,
          "X-Vaskel-Session-Id": member.sessionId,
          "X-Vaskel-Assertion-Expires-At": String(Date.now() - 1),
          "Sec-WebSocket-Protocol": `vaskel-v1, vaskel-ticket.${prepared.ticket}`,
        },
      }),
    );
    expect(rejected.status).toBe(401);
    expect(await readHttpFailure(rejected)).toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const stream = await socket(owner, id, member, prepared);
    stream.client.close();
  });

  it("rejects a ticket under another user, another session or missing principal without consuming it", async () => {
    const { id, owner } = await server();
    await inviteMember(owner);
    const prepared = await owner.prepareSocket(alice(), { channelId: id });
    if (prepared.kind !== "socket_ticket") throw new Error("Expected ticket");
    const headers = new Headers({
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `vaskel-v1, vaskel-ticket.${prepared.ticket}`,
    });
    for (const candidate of [
      { userId: "bob", sessionId: "session-alice" },
      { userId: "alice", sessionId: "session-new-alice" },
      null,
    ]) {
      const forwarded = new Headers(headers);
      if (candidate) {
        forwarded.set("X-Vaskel-User-Id", candidate.userId);
        forwarded.set("X-Vaskel-Session-Id", candidate.sessionId);
        forwarded.set(
          "X-Vaskel-Assertion-Expires-At",
          String(alice().expiresAt),
        );
      }
      const rejected = await owner.fetch(
        new Request("https://vaskel.test/events", { headers: forwarded }),
      );
      expect(rejected.status).toBe(403);
      await rejected.text();
      await runInDurableObject(owner, (_instance, state) => {
        expect(
          state.storage.sql
            .exec("SELECT COUNT(*) AS count FROM socket_tickets")
            .one(),
        ).toEqual({ count: 1 });
        expect(state.getWebSockets()).toHaveLength(0);
      });
    }
    const stream = await socket(owner, id, alice(), prepared);
    expect(stream.frames[0]).toMatchObject({
      type: "ready",
      leaseExpiresAt: prepared.leaseExpiresAt,
    });
    await runInDurableObject(owner, (_instance, state) => {
      expect(
        state.storage.sql
          .exec("SELECT COUNT(*) AS count FROM socket_tickets")
          .one(),
      ).toEqual({ count: 0 });
    });
    const closed = new Promise<void>((resolve) =>
      stream.client.addEventListener("close", () => resolve()),
    );
    stream.client.close(1000);
    await closed;
  });

  it.each([undefined, 1000, 1001, 4000])(
    "completes a peer close handshake with code %s",
    async (code) => {
      const { id, owner } = await server();
      const stream = await socket(owner, id);
      const closed = new Promise<CloseEvent>((resolve) =>
        stream.client.addEventListener("close", resolve, { once: true }),
      );
      stream.client.close(code);
      expect(await closed).toMatchObject({
        code: code ?? 1005,
        wasClean: true,
      });
      await expect
        .poll(() =>
          runInDurableObject(
            owner,
            (_instance, state) => state.getWebSockets().length,
          ),
        )
        .toBe(0);
    },
  );

  it("restores an active hibernating socket without extending its authentication lease", async () => {
    const { id, owner } = await server();
    const stream = await socket(owner, id);
    const initial = stream.frames[0];
    if (initial?.type !== "ready") throw new Error("Expected ready frame");
    await evictDurableObject(owner);
    const reconciled = stream.next();
    stream.client.send('{"type":"reconcile"}');
    expect(await reconciled).toEqual({
      type: "reconcile",
      cursor: initial.cursor,
    });
    const committed = stream.next();
    receipt((await owner.send(alice(), send(id))).outcome);
    expect(await committed).toMatchObject({
      type: "committed",
      cursor: { sequence: 1, generation: initial.cursor.generation },
    });
    await runInDurableObject(owner, (_instance, state) => {
      expect(state.getWebSockets()[0]?.deserializeAttachment()).toMatchObject({
        userId: "alice",
        leaseExpiresAt: stream.prepared.leaseExpiresAt,
      });
    });
    const closed = new Promise<void>((resolve) =>
      stream.client.addEventListener("close", () => resolve()),
    );
    stream.client.close(1000);
    await closed;
  });

  it("rejects expired tickets and closes expired authorization even after actor reconstruction", async () => {
    const { id, owner } = await server();
    const prepared = await owner.prepareSocket(alice(), { channelId: id });
    if (prepared.kind !== "socket_ticket") throw new Error("Expected ticket");
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec("UPDATE socket_tickets SET expires_at = 0");
    });
    const expiredTicket = await owner.fetch(
      new Request("https://vaskel.test/events", {
        headers: {
          Upgrade: "websocket",
          "X-Vaskel-User-Id": "alice",
          "X-Vaskel-Session-Id": "session-alice",
          "X-Vaskel-Assertion-Expires-At": String(alice().expiresAt),
          "Sec-WebSocket-Protocol": `vaskel-v1, vaskel-ticket.${prepared.ticket}`,
        },
      }),
    );
    expect(expiredTicket.status).toBe(403);
    await expiredTicket.text();
    const stream = await socket(owner, id);
    await runInDurableObject(owner, (_instance, state) => {
      for (const websocket of state.getWebSockets()) {
        const value = websocket.deserializeAttachment();
        websocket.serializeAttachment({ ...value, leaseExpiresAt: 0 });
      }
    });
    const closed = new Promise<void>((resolve) =>
      stream.client.addEventListener("close", () => resolve()),
    );
    const expired = stream.next();
    expect(await runDurableObjectAlarm(owner)).toBe(true);
    expect(await expired).toEqual({ type: "lease_expired" });
    stream.client.close();
    await closed;
    await evictDurableObject(owner, { webSockets: "close" });
    expect(await owner.snapshot(alice(), { channelId: id })).toMatchObject({
      kind: "snapshot",
    });
  });
});
