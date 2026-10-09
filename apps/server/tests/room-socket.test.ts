import { acceptedMessage as accepted } from "@tests/helpers/messaging";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import {
  refreshOwnerAlarm,
  ownerAlarm,
} from "@/server/actors/shared/maintenance";
import { ownerCapacity } from "@/server/actors/shared/capacity";
import { renewSocket } from "@/server/actors/shared/sockets";
import { messageCommand } from "@tests/helpers/application-harness";
import { principal, room, socket, barrier } from "@tests/helpers/room-socket";

describe("room socket progress and transient signals", () => {
  it.each(["expired", "malformed"])(
    "retries an OPEN %s socket after independent send/close failures and stops after recovery",
    async (kind) => {
      const { id, owner } = await room();
      const stream = await socket(owner, id);
      try {
        await runInDurableObject(owner, async (_instance, state) => {
          const db = openOwnerDatabase(state.storage);
          const native = state.getWebSockets()[0]!;
          const now = Date.now() + 60_000;
          const clock = vi.spyOn(Date, "now").mockReturnValue(now);
          native.serializeAttachment(
            kind === "malformed"
              ? null
              : { ...native.deserializeAttachment(), leaseExpiresAt: now },
          );
          const send = vi.spyOn(native, "send").mockImplementation(() => {
            throw new Error("send failed");
          });
          const close = vi.spyOn(native, "close").mockImplementation(() => {
            throw new Error("close failed");
          });
          try {
            for (let pass = 0; pass < 3; pass++) {
              await ownerAlarm(state, db);
              await refreshOwnerAlarm(state, db);
              expect(native.readyState).toBe(WebSocket.OPEN);
              expect(await state.storage.getAlarm()).toBe(
                Math.ceil((now + pass * 30_000 + 1) / 30_000) * 30_000,
              );
              expect(
                await ownerCapacity(state, db, principal("alice"), Infinity),
              ).toMatchObject({ sockets: { active: 1 } });
              clock.mockReturnValue(now + (pass + 1) * 30_000);
            }
            expect(send).toHaveBeenCalledTimes(3);
            expect(close).toHaveBeenCalledTimes(3);
            close.mockRestore();
            await ownerAlarm(state, db);
            await refreshOwnerAlarm(state, db);
            expect(native.readyState).not.toBe(WebSocket.OPEN);
            expect(await state.storage.getAlarm()).toBeNull();
          } finally {
            send.mockRestore();
            close.mockRestore();
            clock.mockRestore();
          }
        });
        expect(await runDurableObjectAlarm(owner)).toBe(false);
      } finally {
        await stream.close();
        await evictDurableObject(owner, { webSockets: "close" });
      }
    },
  );

  it("renews one connection across hibernation and preserves later authority on reordered or repeated requests", async () => {
    const { id, owner } = await room();
    const stream = await socket(owner, id);
    const input = { channelId: id, connectionId: stream.ready.connectionId };
    try {
      await runInDurableObject(owner, (_instance, state) => {
        const connection = state.getWebSockets()[0]!;
        connection.serializeAttachment({
          ...connection.deserializeAttachment(),
          leaseExpiresAt: Date.now() + 5_000,
        });
      });
      const fresh = { ...principal("alice"), expiresAt: Date.now() + 25_000 };
      const renewed = await owner.renewSocket(fresh, input);
      expect(renewed).toEqual({
        kind: "socket_renewed",
        connectionId: input.connectionId,
        leaseExpiresAt: fresh.expiresAt,
      });
      // An HTTP response lost after attachment publication needs no receipt ledger.
      expect(await owner.renewSocket(fresh, input)).toEqual(renewed);
      expect(
        await owner.renewSocket(
          { ...fresh, expiresAt: Date.now() + 10_000 },
          input,
        ),
      ).toEqual(renewed);
      await evictDurableObject(owner, { webSockets: "hibernate" });
      expect(await owner.renewSocket(fresh, input)).toEqual(renewed);
      // The old deadline can still wake the owner after renewal; it must read
      // the persisted new lease instead of closing this healthy connection.
      expect(await runDurableObjectAlarm(owner)).toBe(true);
      await runInDurableObject(owner, async (_instance, state) => {
        const connections = state.getWebSockets();
        expect(connections).toHaveLength(1);
        expect(connections[0]!.deserializeAttachment()).toMatchObject({
          connectionId: input.connectionId,
          leaseExpiresAt: fresh.expiresAt,
        });
        expect(await state.storage.getAlarm()).toBeLessThanOrEqual(
          Math.ceil(fresh.expiresAt / 30_000) * 30_000,
        );
      });
      accepted(
        (await owner.send(principal("alice"), messageCommand(id))).outcome,
      );
      expect(await stream.next()).toMatchObject({ type: "committed" });
      expect(
        stream.frames.filter((frame) => frame.type === "ready"),
      ).toHaveLength(1);
    } finally {
      await stream.close();
      // Drain native close callbacks before the next fixture's global reset.
      await evictDurableObject(owner, { webSockets: "close" });
    }
  });

  it("cannot renew another connection, channel, account or session, or revive an expired lease", async () => {
    const { id, owner } = await room();
    const stream = await socket(owner, id);
    const input = { channelId: id, connectionId: stream.ready.connectionId };
    try {
      expect(
        await owner.renewSocket({ ...principal("alice"), expiresAt: 0 }, input),
      ).toEqual({ kind: "unauthenticated" });
      for (const [user, request] of [
        [principal("alice"), { ...input, connectionId: crypto.randomUUID() }],
        [principal("alice"), { ...input, channelId: "elsewhere" }],
        [principal("bob"), input],
        [{ ...principal("alice"), sessionId: "replacement-session" }, input],
      ] as const) {
        expect(await owner.renewSocket(user, request)).toEqual({
          kind: "socket_unavailable",
        });
      }
      await barrier(stream);
      await runInDurableObject(owner, (_instance, state) => {
        const connection = state.getWebSockets()[0]!;
        connection.serializeAttachment({
          ...connection.deserializeAttachment(),
          leaseExpiresAt: 0,
        });
      });
      expect(await owner.renewSocket(principal("alice"), input)).toEqual({
        kind: "socket_unavailable",
      });
      expect(await stream.next()).toEqual({ type: "lease_expired" });
    } finally {
      await stream.close();
      await evictDurableObject(owner, { webSockets: "close" });
    }
  });

  it("refuses permission loss and authority or socket expiry during awaited renewal work", async () => {
    const { id, owner } = await room();
    for (const expired of ["principal", "socket"] as const) {
      const stream = await socket(owner, id);
      const input = { channelId: id, connectionId: stream.ready.connectionId };
      try {
        await runInDurableObject(owner, async (_instance, state) => {
          const connection = state
            .getWebSockets()
            .find(
              (candidate) =>
                candidate.deserializeAttachment().connectionId ===
                input.connectionId,
            )!;
          const before = connection.deserializeAttachment();
          const now = Date.now();
          const user = {
            ...principal("alice"),
            expiresAt: now + (expired === "principal" ? 5_000 : 60_000),
          };
          const clock = vi.spyOn(Date, "now").mockReturnValue(now);
          const getAlarm = state.storage.getAlarm.bind(state.storage);
          const alarm = vi
            .spyOn(state.storage, "getAlarm")
            .mockImplementation(async () => {
              const value = await getAlarm();
              clock.mockReturnValue(now + 31_000);
              return value;
            });
          try {
            expect(
              await renewSocket(
                state,
                openOwnerDatabase(state.storage),
                user,
                input,
              ),
            ).toEqual({
              kind:
                expired === "principal"
                  ? "unauthenticated"
                  : "socket_unavailable",
            });
            expect(connection.deserializeAttachment()).toEqual(before);
          } finally {
            alarm.mockRestore();
            clock.mockRestore();
          }
        });
      } finally {
        await stream.close();
      }
    }
    const stream = await socket(owner, id);
    try {
      await runInDurableObject(owner, (_instance, state) => {
        state.storage.sql.exec("DELETE FROM members WHERE user_id = 'alice'");
      });
      expect(
        await owner.renewSocket(principal("alice"), {
          channelId: id,
          connectionId: stream.ready.connectionId,
        }),
      ).toEqual({ kind: "forbidden" });
      expect(await stream.next()).toEqual({ type: "access_changed" });
    } finally {
      await stream.close();
      await evictDurableObject(owner, { webSockets: "close" });
    }
  });

  it("uses native auto-pong and throttles authorized typing while checking both sides for revoked access and expired leases", async () => {
    const { id, owner } = await room();
    const channelId = crypto.randomUUID();
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO channels(id,name,private,version,kind) VALUES (?, 'Private', 1, 1, 'text')",
        channelId,
      );
      for (const userId of ["alice", "bob", "carol", "dave"]) {
        state.storage.sql.exec(
          "INSERT OR IGNORE INTO members(user_id,role) VALUES (?, 'member')",
          userId,
        );
        state.storage.sql.exec(
          "INSERT INTO channel_members(channel_id,user_id) VALUES (?, ?)",
          channelId,
          userId,
        );
      }
    });
    const sender = await socket(owner, channelId);
    const recipient = await socket(owner, channelId, "bob");
    const revoked = await socket(owner, channelId, "carol");
    const expired = await socket(owner, channelId, "dave");
    const other = await socket(owner, id, "bob");
    const streams = [sender, recipient, revoked, expired, other];
    try {
      sender.client.send('{"type":"ping"}');
      expect(await sender.next()).toEqual({ type: "pong" });
      await runInDurableObject(owner, (_instance, state) => {
        const source = state
          .getWebSockets()
          .find(
            (connection) =>
              connection.deserializeAttachment().userId === "alice",
          )!;
        expect(state.getWebSocketAutoResponseTimestamp(source)).toBeInstanceOf(
          Date,
        );
        state.storage.sql.exec(
          "DELETE FROM channel_members WHERE user_id = 'carol'",
        );
        for (const connection of state.getWebSockets()) {
          const value = connection.deserializeAttachment();
          if (value.userId === "dave")
            connection.serializeAttachment({ ...value, leaseExpiresAt: 0 });
        }
      });
      sender.client.send('{"type":"typing"}');
      const typing = await recipient.next();
      expect(typing).toMatchObject({
        type: "typing",
        channelId,
        userId: "alice",
      });
      if (typing.type !== "typing") throw new Error(typing.type);
      expect(typing.expiresAt).toBeGreaterThan(Date.now());
      expect(typing.expiresAt).toBeLessThanOrEqual(Date.now() + 6_000);
      expect(await revoked.next()).toEqual({ type: "access_changed" });
      expect(await expired.next()).toEqual({ type: "lease_expired" });
      sender.client.send('{"type":"typing"}');
      await barrier(sender);
      await barrier(recipient);
      await barrier(other);
      expect(
        recipient.frames.filter((frame) => frame.type === "typing"),
      ).toHaveLength(1);
      expect(other.frames.some((frame) => frame.type === "typing")).toBe(false);
      expect(sender.frames.some((frame) => frame.type === "typing")).toBe(
        false,
      );
      await runInDurableObject(owner, (_instance, state) => {
        state.storage.sql.exec(
          "DELETE FROM channel_members WHERE user_id = 'alice'",
        );
        expect(
          state.storage.sql.exec("SELECT high_water FROM owner_state").one(),
        ).toEqual({ high_water: 0 });
        expect(
          state.storage.sql.exec("SELECT COUNT(*) AS n FROM events").one(),
        ).toEqual({ n: 0 });
      });
      sender.client.send('{"type":"typing"}');
      expect(await sender.next()).toEqual({ type: "access_changed" });
      await barrier(recipient);
      expect(
        recipient.frames.filter((frame) => frame.type === "typing"),
      ).toHaveLength(1);
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
    }
  });
});
