import { observeSql } from "@tests/helpers/sql-observer";
import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import {
  eventDispatchName,
  eventDispatchStub,
  groupEventDispatchRecipients,
} from "@/server/event-dispatch/routing";
import {
  EVENT_DISPATCH_RECIPIENT_LIMIT,
  EVENT_DISPATCH_TICKET_LIMIT,
} from "@/server/event-dispatch/limits";
import { EVENT_DISPATCH_SILENCE_MS } from "@/server/actors/event-dispatch/presence";
import type { EventDispatchPrincipal } from "@/server/actors/event-dispatch/store";
import {
  accountTag,
  attachment,
  openSocketCount,
} from "@/server/actors/event-dispatch/sockets";
import { accountEventsSocket } from "@tests/helpers/event-dispatch-harness";

function principal(
  userId = crypto.randomUUID(),
  sessionId = crypto.randomUUID(),
): EventDispatchPrincipal {
  return {
    userId,
    sessionId,
    authEpoch: 0,
    expiresAt: Date.now() + 30_000,
    sessionExpiresAt: Date.now() + 900_000,
  };
}
function samePartition(userId: string) {
  for (;;) {
    const candidate = crypto.randomUUID();
    if (eventDispatchName(candidate) === eventDispatchName(userId))
      return candidate;
  }
}
function upgrade(p: EventDispatchPrincipal, ticket: string) {
  return new Request("https://vaskel.test/private-events", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `vaskel-account-events-v1, vaskel-ticket.${ticket}`,
      "X-Vaskel-User-Id": p.userId,
      "X-Vaskel-Session-Id": p.sessionId,
      "X-Vaskel-Auth-Epoch": String(p.authEpoch),
      "X-Vaskel-Session-Expires-At": String(p.sessionExpiresAt),
    },
  });
}
async function open(p: EventDispatchPrincipal) {
  const hub = eventDispatchStub(env, p.userId);
  const ticket = await hub.prepareSocket(p);
  if (ticket.kind !== "event_ticket") throw new Error(ticket.kind);
  return accountEventsSocket(await hub.fetch(upgrade(p, ticket.ticket)));
}
async function online(userId: string) {
  const result = await eventDispatchStub(env, userId).samplePresence([userId]);
  if (result.kind !== "presence_samples") throw new Error(result.kind);
  return result.samples[0]!.state;
}

describe("partitioned event dispatch", () => {
  it("isolates private frames and qualified exact/epoch fences between accounts sharing a hub", async () => {
    const first = principal();
    const second = principal(samePartition(first.userId), first.sessionId);
    const hub = eventDispatchStub(env, first.userId);
    const streams = await Promise.all([
      open(first),
      open(second),
      open(second),
    ]);
    const owner = { kind: "server" as const, id: crypto.randomUUID() };
    const notice = {
      type: "read" as const,
      owner,
      channelId: crypto.randomUUID(),
      generation: crypto.randomUUID(),
      sequence: 7,
    };
    try {
      expect(await hub.deliver({ recipients: [first.userId], notice })).toEqual(
        { kind: "delivered" },
      );
      await Promise.all(streams.map((stream) => stream.sync()));
      expect(streams[0]!.frames).toContainEqual(notice);
      expect(streams[1]!.frames).not.toContainEqual(notice);
      expect(streams[2]!.frames).not.toContainEqual(notice);
      await hub.revoke(first.userId, {
        kind: "session",
        sessionId: first.sessionId,
        expiresAt: first.sessionExpiresAt,
      });
      await streams[0]!.closed;
      expect(await online(first.userId)).toBe("offline");
      expect(await online(second.userId)).toBe("online");
      expect((await hub.prepareSocket(second)).kind).toBe("event_ticket");
      await hub.revoke(first.userId, { kind: "epoch", minimumAuthEpoch: 5 });
      expect((await hub.prepareSocket(second)).kind).toBe("event_ticket");
      expect((await hub.fetch(upgrade(second, "a".repeat(64)))).status).toBe(
        403,
      );
      expect(
        await hub.samplePresence(
          Array.from(
            { length: EVENT_DISPATCH_RECIPIENT_LIMIT + 1 },
            () => first.userId,
          ),
        ),
      ).toEqual({ kind: "capacity" });
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
    }
  });

  it("samples first/last connections immediately through duplicate callbacks, reconnect and eviction", async () => {
    const p = principal();
    const hub = eventDispatchStub(env, p.userId);
    const one = await open(p);
    const two = await open(p);
    expect(await online(p.userId)).toBe("online");
    await one.close();
    expect(await online(p.userId)).toBe("online");
    const oldAttachment = await runInDurableObject(hub, (_, state) =>
      attachment(state.getWebSockets(accountTag(p.userId))[0]!)!,
    );
    await two.close();
    expect(await online(p.userId)).toBe("offline");
    await runInDurableObject(hub, async (instance, state) => {
      const oldSocket = {
        deserializeAttachment: () => oldAttachment,
        close() {},
      } as unknown as WebSocket;
      const observed = await observeSql(state.storage.sql, async () => {
        await instance.webSocketClose(oldSocket, 1000);
        await instance.webSocketClose(oldSocket, 1000);
      });
      expect(
        observed.statements.reduce(
          (n, statement) => n + statement.rowsWritten,
          0,
        ),
      ).toBe(0);
    });
    await evictDurableObject(hub, { webSockets: "close" });
    expect(await online(p.userId)).toBe("offline");
    const resumed = await open(p);
    try {
      await runInDurableObject(hub, (instance) =>
        instance.webSocketClose(
          {
            deserializeAttachment: () => oldAttachment,
            close() {},
          } as unknown as WebSocket,
          1000,
        ),
      );
      expect(await online(p.userId)).toBe("online");
    } finally {
      await resumed.close();
    }
    expect(await online(p.userId)).toBe("offline");
  });

  it("delivers healthy hints without presence writes, discovery or alarm maintenance", async () => {
    const p = principal();
    const hub = eventDispatchStub(env, p.userId);
    const stream = await open(p);
    try {
      const notice = {
        type: "presence" as const,
        owner: { kind: "server" as const, id: crypto.randomUUID() },
        userId: p.userId,
      };
      await runInDurableObject(hub, async (instance, state) => {
        const background = vi.spyOn(state, "waitUntil");
        const setAlarm = vi.spyOn(state.storage, "setAlarm");
        try {
          const observed = await observeSql(state.storage.sql, () =>
            instance.deliver({ recipients: [p.userId], notice }),
          );
          expect(
            observed.statements.reduce(
              (n, statement) => n + statement.rowsWritten,
              0,
            ),
          ).toBe(0);
          expect(background).not.toHaveBeenCalled();
          expect(setAlarm).not.toHaveBeenCalled();
        } finally {
          background.mockRestore();
          setAlarm.mockRestore();
        }
      });
      await stream.sync();
      expect(
        stream.frames.filter((frame) => frame.type === "presence"),
      ).toEqual([notice]);
      await runInDurableObject(hub, async (instance, state) => {
        const socket = state.getWebSockets(accountTag(p.userId))[0]!;
        socket.serializeAttachment({
          ...socket.deserializeAttachment(),
          leaseExpiresAt: Date.now() - 1,
        });
        await instance.deliver({ recipients: [p.userId], notice });
        expect(socket.readyState).toBe(WebSocket.OPEN);
        expect(openSocketCount(state)).toBe(1);
        expect(await instance.samplePresence([p.userId])).toMatchObject({
          samples: [{ state: "offline" }],
        });
        await instance.alarm();
      });
      await stream.closed;
      expect(
        stream.frames.filter((frame) => frame.type === "presence"),
      ).toEqual([notice]);
    } finally {
      await stream.close();
    }
  });

  it("uses native pongs after eviction without extending session authority or writing periodic presence", async () => {
    const p = principal();
    const hub = eventDispatchStub(env, p.userId);
    const active = await open(p);
    const silent = await open(p);
    await active.sync();
    await runInDurableObject(hub, async (instance, state) => {
      for (const socket of state.getWebSockets(accountTag(p.userId)))
        socket.serializeAttachment({
          ...socket.deserializeAttachment(),
          openedAt: Date.now() - EVENT_DISPATCH_SILENCE_MS - 1,
        });
      await instance.alarm();
    });
    await silent.closed;
    expect(silent.frames).toContainEqual({ type: "lease_expired" });
    await evictDurableObject(hub, { webSockets: "hibernate" });
    expect(await online(p.userId)).toBe("online");
    await runInDurableObject(hub, async (instance, state) => {
      state.storage.sql.exec(
        "CREATE TRIGGER no_periodic_presence BEFORE UPDATE ON dispatch_accounts BEGIN SELECT RAISE(ABORT, 'periodic presence write'); END",
      );
      await instance.alarm();
    });
    await active.sync();
    expect(await online(p.userId)).toBe("online");
    await hub.deliver({
      recipients: [p.userId],
      notice: {
        type: "directory",
        owner: { kind: "server", id: crypto.randomUUID() },
      },
    });
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec("DROP TRIGGER no_periodic_presence");
    });
    await active.close();
    expect(await online(p.userId)).toBe("offline");
    await hub.revoke(p.userId, { kind: "epoch", minimumAuthEpoch: 1 });
    expect(await online(p.userId)).toBe("offline");
  });

  it("retains a still-open socket's total capacity slot when native close acknowledgement throws", async () => {
    const p = principal();
    const hub = eventDispatchStub(env, p.userId);
    const stream = await open(p);
    await runInDurableObject(hub, async (instance, state) => {
      const socket = state.getWebSockets(accountTag(p.userId))[0]!;
      const before = openSocketCount(state);
      Object.defineProperty(socket, "close", {
        configurable: true,
        value() {
          throw new Error("injected native acknowledgement failure");
        },
      });
      try {
        await expect(instance.webSocketClose(socket, 1005)).rejects.toThrow(
          "injected",
        );
        expect(socket.readyState).toBe(WebSocket.OPEN);
        expect(openSocketCount(state)).toBe(before);
      } finally {
        Reflect.deleteProperty(socket, "close");
      }
    });
    await stream.close();
    await runInDurableObject(hub, (_instance, state) =>
      expect(openSocketCount(state)).toBe(0),
    );
  });

  it("retries failed close cleanup after explicit revocation has already made an account offline", async () => {
    const p = principal();
    const hub = eventDispatchStub(env, p.userId);
    const stream = await open(p);
    await runInDurableObject(hub, async (instance, state) => {
      const socket = state.getWebSockets(accountTag(p.userId))[0]!;
      Object.defineProperty(socket, "close", {
        configurable: true,
        value() {
          throw new Error("injected close failure");
        },
      });
      try {
        await instance.revoke(p.userId, { kind: "epoch", minimumAuthEpoch: 1 });
        expect(socket.readyState).toBe(WebSocket.OPEN);
        expect(openSocketCount(state)).toBe(1);
        expect(await instance.samplePresence([p.userId])).toMatchObject({
          samples: [{ state: "offline" }],
        });
        socket.serializeAttachment({
          ...socket.deserializeAttachment(),
          openedAt: Date.now() - 120_000,
        });
        await instance.alarm();
        expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
        expect((await state.storage.getAlarm())! % 30_000).toBe(0);
      } finally {
        Reflect.deleteProperty(socket, "close");
      }
      await instance.alarm();
      expect(socket.readyState).not.toBe(WebSocket.OPEN);
      expect(openSocketCount(state)).toBe(0);
      expect(await state.storage.getAlarm()).toBeNull();
    });
    await stream.closed;
  });

  it("returns explicit hub ticket overload without consuming another account's allowance", async () => {
    const p = principal();
    const hub = eventDispatchStub(env, p.userId);
    await hub.prepareSocket(p);
    await runInDurableObject(hub, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM dispatch_tickets");
      state.storage.sql.exec(
        "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < ?) INSERT INTO dispatch_tickets(ticket_hash,user_id,session_id,auth_epoch,expires_at,lease_expires_at) SELECT printf('%064d', x),?, 'other',0,?,? FROM n",
        EVENT_DISPATCH_TICKET_LIMIT,
        samePartition(p.userId),
        Date.now() + 30_000,
        Date.now() + 900_000,
      );
    });
    expect(await hub.prepareSocket(p)).toEqual({ kind: "capacity" });
  });

  it("delivers grouped hints across hubs and samples past the account batch boundary with duplicate sockets", async () => {
    const accounts = [principal("00000000-0000-4000-8000-000000000000")];
    const firstPartition = eventDispatchName(accounts[0]!.userId);
    let otherPartition: EventDispatchPrincipal | undefined;
    for (let index = 1; accounts.length < 65 || !otherPartition; index++) {
      const candidate = principal(
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      );
      if (eventDispatchName(candidate.userId) === firstPartition) {
        if (accounts.length < 65) accounts.push(candidate);
      } else otherPartition ??= candidate;
    }
    accounts.push(otherPartition!);
    const streams: Awaited<ReturnType<typeof open>>[] = [];
    try {
      for (const p of accounts) streams.push(await open(p));
      streams.push(await open(accounts[0]!));
      const batches = groupEventDispatchRecipients(
        accounts.map((p) => p.userId),
      );
      expect(
        batches
          .map((batch) => batch.recipients.length)
          .toSorted((a, b) => a - b),
      ).toEqual([1, 65]);
      const notice = {
        type: "directory" as const,
        owner: { kind: "server" as const, id: crypto.randomUUID() },
      };
      for (const batch of batches)
        expect(
          await eventDispatchStub(env, batch.recipients[0]!).deliver({
            recipients: batch.recipients,
            notice,
          }),
        ).toEqual({ kind: "delivered" });
      for (const batch of batches) {
        const result = await eventDispatchStub(
          env,
          batch.recipients[0]!,
        ).samplePresence(batch.recipients);
        expect(result.kind).toBe("presence_samples");
        if (result.kind === "presence_samples") {
          expect(result.samples).toHaveLength(batch.recipients.length);
          expect(
            result.samples.map(({ userId, state }) => ({ userId, state })),
          ).toEqual(
            expect.arrayContaining(
              batch.recipients.map((userId) => ({ userId, state: "online" })),
            ),
          );
        }
      }
      await Promise.all(streams.map((stream) => stream.sync()));
      for (const stream of streams)
        expect(
          stream.frames.filter((frame) => frame.type === "directory"),
        ).toEqual([notice]);
    } finally {
      await Promise.all(streams.map((stream) => stream.close()));
    }
  }, 60_000);
});
