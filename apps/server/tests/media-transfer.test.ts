import { sha256Hex } from "@/server/auth/crypto";
import { barrier } from "@tests/helpers/barrier";
import { env } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AccountMediaCoordinator } from "@/server/actors/account-media/lifecycle";
import { markParticipantClosing } from "@/server/actors/media/cleanup";
import type { RoomRuntime } from "@/server/actors/media/store";
import { mediaRoomKey } from "@/server/media/authorization";
import { mediaNetwork } from "@tests/helpers/media-network";
import {
  grant,
  joined,
  publication,
  publishReady,
  request,
  room,
  setup,
  token,
} from "@tests/helpers/media-room";
import {
  blockProviderSession,
  participant,
  providerSession,
  publishParticipant,
  snapshot,
} from "@tests/helpers/media-lifecycle";

beforeAll(() => mediaNetwork.enable());
afterEach(() => mediaNetwork.resetHandlers());
afterAll(async () => {
  // Terminate isolated actors before removing their provider interception.
  await abortAllDurableObjects();
  await mediaNetwork.disable();
});

describe("eventual explicit device transfer on native actors", () => {
  it.each([false, true])(
    "admits B while old forwarding is blocked (same room: %s)",
    async (sameRoom) => {
      const s = setup();
      const a = joined(
        await s.account.join(
          s.principal,
          grant(s.principal, s.scope),
          request(s.scope),
        ),
      );
      await publishReady(s, a.handle);
      const oldProvider = await providerSession(s, a.handle);
      const blocked = blockProviderSession(s.fake, oldProvider, "close");
      const target = sameRoom ? s.scope : room();
      const command = request(target, a.generation);
      try {
        const b = joined(
          await s.account.transfer(
            s.principal,
            grant(s.principal, target),
            command,
          ),
        );
        await blocked.wait();
        expect(s.fake.sessions.get(oldProvider)?.tracks.size).toBe(1);
        expect(await s.account.status(s.principal)).toMatchObject({
          generation: b.generation,
          admission: { kind: "transfer_required" },
        });
        expect(
          await s.account.validateClaim(s.principal, a.handle),
        ).toMatchObject({ kind: "stale_generation" });
        expect(
          b.snapshot.participants.filter(
            (p) => p.id === a.handle.participantId,
          ),
        ).toMatchObject([{ generation: b.generation }]);
        expect((await snapshot(s)).participants).toHaveLength(sameRoom ? 1 : 0);
        // Losing the response and evicting the account recovers the exact receipt.
        await evictDurableObject(s.account);
        const recovered = joined(
          await s.account.transfer(
            s.principal,
            grant(s.principal, target),
            command,
          ),
        );
        expect(recovered.handle).toEqual(b.handle);
        expect(s.fake.sessions.size).toBe(1);
      } finally {
        blocked.release();
      }
    },
  );

  it("recovers the accepted command after interruption between room admission and account acknowledgement", async () => {
    const s = setup();
    const a = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    const command = request(s.scope, a.generation);
    const interrupted = await runInDurableObject(
      s.account,
      async (_, state) => {
        const namespace = new Proxy(env.MEDIA_ROOM, {
          get(namespace, property) {
            if (property !== "getByName")
              return Reflect.get(namespace, property);
            return (name: string) => {
              const stub = namespace.getByName(name);
              return new Proxy(stub, {
                get(stub, property) {
                  if (property === "admit")
                    return async (...args: Parameters<typeof stub.admit>) => {
                      await stub.admit(...args);
                      throw new Error("fixture lost admission acknowledgement");
                    };
                  return Reflect.get(stub, property);
                },
              });
            };
          },
        });
        try {
          await new AccountMediaCoordinator(state, {
            ...env,
            MEDIA_ROOM: namespace,
          }).transfer(s.principal, grant(s.principal, s.scope), command);
          return "unexpected acceptance";
        } catch (error) {
          return String(error);
        }
      },
    );
    expect(interrupted).toContain("fixture lost admission acknowledgement");
    expect(await s.account.status(s.principal)).toMatchObject({
      generation: 2,
      admission: { kind: "transfer_required" },
    });
    await evictDurableObject(s.account);
    const recovered = joined(
      await s.account.transfer(
        s.principal,
        grant(s.principal, s.scope),
        command,
      ),
    );
    expect(recovered.generation).toBe(2);
    expect(s.fake.sessions.size).toBe(0);
  });

  it("fences pending Leave after accepted transfer without allocating destination sessions", async () => {
    const s = setup();
    const a = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await publishReady(s, a.handle);
    const command = request(s.scope, a.generation);
    const transferred = joined(
      await s.account.transfer(
        s.principal,
        grant(s.principal, s.scope),
        command,
      ),
    );
    expect(s.fake.sessions.size).toBe(1);
    expect(
      await s.account.leave(s.principal, {
        pending: { path: "transfer", body: command },
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    ).toMatchObject({ kind: "left", cleanupPending: false });
    expect(
      await s.media.publish(
        s.principal,
        grant(s.principal, s.scope),
        publication(transferred.handle),
      ),
    ).toMatchObject({ kind: "stale_generation" });
    expect(s.fake.sessions.size).toBe(1);
    expect((await snapshot(s)).participants).toEqual([]);
  });

  it("keeps delayed operational cleanup owned until its late allocations settle during transfer", async () => {
    const s = setup();
    const a = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await publishReady(s, a.handle);
    const provider = await providerSession(s, a.handle);
    const gate = blockProviderSession(s.fake, provider);
    const closing = s.media.endClaim({
      room: s.scope,
      participantId: a.handle.participantId,
      generation: a.generation,
      reason: "replace",
    });
    try {
      await gate.wait();
      const b = joined(
        await s.account.transfer(
          s.principal,
          grant(s.principal, s.scope),
          request(s.scope, a.generation),
        ),
      );
      expect(b.generation).toBe(2);
      await runInDurableObject(s.media, (_, state) => {
        expect(
          state.storage.sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) AS n FROM media_sessions WHERE generation=1",
            )
            .one().n,
        ).toBe(2);
      });
    } finally {
      gate.release();
    }
    await closing;
    await runDurableObjectAlarm(s.media);
    await runInDurableObject(s.media, (_, state) => {
      expect(
        state.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM media_allocations a LEFT JOIN media_sessions s ON a.session_key=s.session_key WHERE s.session_key IS NULL",
          )
          .one().n,
      ).toBe(0);
      expect(
        state.storage.sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM media_sessions WHERE generation=1",
          )
          .one().n,
      ).toBe(0);
    });
  });

  it("replaces one person in a full room and bounds rapid replacement independently", async () => {
    const s = setup();
    let current = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    for (let index = 0; index < 15; index++)
      await participant(s, `full-room-${index}`);
    await publishReady(s, current.handle);
    s.fake.failClose = true;
    let last = request(s.scope, current.generation);
    for (let index = 0; index < 16; index++) {
      last = request(s.scope, current.generation);
      current = joined(
        await s.account.transfer(
          s.principal,
          grant(s.principal, s.scope),
          last,
        ),
      );
      expect(current.snapshot.participants).toHaveLength(16);
      expect(new Set(current.snapshot.participants.map((p) => p.id)).size).toBe(
        16,
      );
    }
    expect(
      await s.account.transfer(s.principal, grant(s.principal, s.scope), last),
    ).toMatchObject({ kind: "joined", generation: current.generation });
    expect(
      await s.account.transfer(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope, current.generation),
      ),
    ).toEqual({ kind: "capacity" });
    await runInDurableObject(s.media, (_, state) => {
      expect(
        state.storage.sql
          .exec<{ n: number }>("SELECT COUNT(*) AS n FROM media_sessions")
          .one().n,
      ).toBeLessThanOrEqual(34);
    });
    // Closing current resources stay enforceable without hiding one of 16 live people.
    await runInDurableObject(s.media, async (instance, state) => {
      const rt = (instance as unknown as { runtime: RoomRuntime }).runtime;
      await state.storage.transaction(() =>
        markParticipantClosing(
          rt,
          { id: "full-room-0", generation: 1 },
          "removed",
        ),
      );
    });
    const replacement = await participant(s, "new-logical-person");
    expect(replacement.accepted.snapshot.participants).toHaveLength(16);
    expect(
      replacement.accepted.snapshot.participants.some(
        (p) => p.id === "full-room-0",
      ),
    ).toBe(false);
    expect(
      replacement.accepted.snapshot.participants.some(
        (p) => p.id === "new-logical-person",
      ),
    ).toBe(true);
  });

  it("repairs lost disposal after old-room outage through its lease despite failed SFU closure", async () => {
    const s = setup();
    const a = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await publishReady(s, a.handle);
    s.fake.failClose = true;
    const target = room();
    const command = request(target, a.generation);
    const b = joined(
      await runInDurableObject(s.account, async (_, state) => {
        const namespace = new Proxy(env.MEDIA_ROOM, {
          get(namespace, property) {
            if (property !== "getByName")
              return Reflect.get(namespace, property);
            return (name: string) => {
              const stub = namespace.getByName(name);
              if (name !== mediaRoomKey(s.scope)) return stub;
              return new Proxy(stub, {
                get(stub, property) {
                  if (property === "endClaim")
                    return async () => {
                      throw new Error("Old room unavailable");
                    };
                  return Reflect.get(stub, property);
                },
              });
            };
          },
        });
        return new AccountMediaCoordinator(state, {
          ...env,
          MEDIA_ROOM: namespace,
        }).transfer(s.principal, grant(s.principal, target), command);
      }),
    );
    expect((await snapshot(s)).participants).toHaveLength(1);
    // A timed-out account lookup first falls back to operational cleanup.
    // Once account RPC recovers, that reason must still be eligible for disposal.
    const gate = barrier();
    let entered = false;
    const holding = runInDurableObject(s.account, async (_, state) => {
      await state.storage.transaction(async () => {
        state.storage.sql
          .exec("SELECT generation FROM account_media")
          .toArray();
        entered = true;
        await gate.promise;
      });
    });
    await expect.poll(() => entered).toBe(true);
    try {
      await runInDurableObject(s.media, (_, state) => {
        state.storage.sql.exec("UPDATE media_participants SET lease_expires=1");
      });
      await runDurableObjectAlarm(s.media);
      await runInDurableObject(s.media, (_, state) => {
        expect(
          state.storage.sql
            .exec("SELECT status,reason FROM media_participants")
            .one(),
        ).toEqual({ status: "closing", reason: "lease_expired" });
      });
    } finally {
      gate.release();
      await holding;
    }
    // Releasing the account transaction does not settle the timed-out RPC.
    // Its keyed work slot remains occupied until the response arrives; the
    // durable successor alarm repairs disposal after that slot is available.
    await expect
      .poll(
        async () => {
          await runDurableObjectAlarm(s.media);
          return runInDurableObject(s.media, (_, state) =>
            state.storage.sql
              .exec("SELECT status,reason FROM media_participants")
              .one(),
          );
        },
        { timeout: 5_000 },
      )
      .toEqual({ status: "left", reason: "transfer" });
    expect((await snapshot(s)).participants).toHaveLength(0);
    expect(await s.account.status(s.principal)).toMatchObject({
      generation: b.generation,
      admission: { kind: "transfer_required" },
    });
  });

  it("allows explicit transfer from operational cleanup but preserves a pending deliberate Leave", async () => {
    const s = setup();
    const a = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await publishReady(s, a.handle);
    s.fake.failClose = true;
    await s.media.endClaim({
      room: s.scope,
      participantId: a.handle.participantId,
      generation: a.generation,
      reason: "replace",
    });
    await runInDurableObject(s.account, (_, state) =>
      state.storage.sql.exec(
        "UPDATE account_media SET participation=json_object('kind','recovering','endpoint',json_extract(participation,'$.endpoint'),'cleanup',json_object('room',json_extract(participation,'$.endpoint.room'),'generation',generation,'reason','replace'))",
      ),
    );
    const b = joined(
      await s.account.transfer(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope, a.generation),
      ),
    );
    await publishReady(s, b.handle);
    expect(
      await s.account.leave(s.principal, {
        handle: b.handle,
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    ).toMatchObject({ kind: "left", cleanupPending: true });
    expect(
      await s.account.transfer(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope, b.generation + 1),
      ),
    ).toMatchObject({ kind: "cleanup_pending" });
    expect(
      await s.account.resume(s.principal, grant(s.principal, s.scope), {
        handle: b.handle,
        nextDeviceToken: token(),
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    ).toMatchObject({ kind: "stale_generation" });
  });

  it("closes both removed participants while one account notification remains blocked", async () => {
    const s = setup();
    const first = await participant(s, "bounded-removal-first");
    const second = await participant(s, "bounded-removal-second");
    await publishParticipant(s, first);
    await publishParticipant(s, second);
    const providers = await Promise.all([
      providerSession(s, first.accepted.handle),
      providerSession(s, second.accepted.handle),
    ]);
    const gate = barrier();
    let entered = false;
    const holding = runInDurableObject(first.account, async (_, state) => {
      await state.storage.transaction(async () => {
        state.storage.sql
          .exec("SELECT generation FROM account_media")
          .toArray();
        entered = true;
        await gate.promise;
      });
    });
    await expect.poll(() => entered).toBe(true);
    await runInDurableObject(s.media, async (instance, state) => {
      const rt = (instance as unknown as { runtime: RoomRuntime }).runtime;
      await state.storage.transaction(async () => {
        for (const person of [first, second])
          await markParticipantClosing(
            rt,
            {
              id: person.accepted.handle.participantId,
              generation: person.accepted.generation,
            },
            "removed",
          );
      });
    });
    const cleaning = runDurableObjectAlarm(s.media);
    try {
      await expect
        .poll(() => s.fake.sessions.get(providers[0]!)?.tracks.size)
        .toBe(0);
      await expect
        .poll(() => s.fake.sessions.get(providers[1]!)?.tracks.size, {
          timeout: 4000,
        })
        .toBe(0);
      await cleaning;
      await runDurableObjectAlarm(s.media);
      await runInDurableObject(s.media, (_, state) => {
        expect(
          state.storage.sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) AS n FROM media_participants WHERE status='left' AND cancellation_pending=1",
            )
            .one().n,
        ).toBe(1);
      });
    } finally {
      gate.release();
      await Promise.all([holding, cleaning]);
      await runDurableObjectAlarm(s.media);
    }
    expect(await first.account.status(first.principal)).toMatchObject({
      admission: {
        kind: expect.toBeOneOf(["available", "cleanup_pending"]),
      },
    });
  });

  it("accepts transfer despite failed obsolete closure and fences stale requests through eviction", async () => {
    const s = setup();
    const accepted = joined(
      await s.account.join(
        s.principal,
        grant(s.principal, s.scope),
        request(s.scope),
      ),
    );
    await publishReady(s, accepted.handle);
    s.fake.failClose = true;
    const target = room();
    const command = request(target, 1);
    const moved = joined(
      await s.account.transfer(
        s.principal,
        grant(s.principal, target),
        command,
      ),
    );
    expect(moved.generation).toBe(2);
    expect(
      await s.account.validateAdmission({
        room: target,
        userId: s.principal.userId,
        sessionId: s.principal.sessionId,
        clientId: command.clientId,
        tokenHash: await sha256Hex(command.deviceToken),
        generation: 2,
        participantId: s.principal.userId,
      }),
    ).toEqual({ kind: "valid_claim" });
    expect(s.fake.sessions.size).toBe(1);
    expect(
      await s.media.publish(
        s.principal,
        grant(s.principal, s.scope),
        publication(accepted.handle),
      ),
    ).toMatchObject({ kind: "stale_generation" });
    await evictDurableObject(s.account);
    expect(
      joined(
        await s.account.transfer(
          s.principal,
          grant(s.principal, target),
          command,
        ),
      ),
    ).toEqual(moved);
    expect(s.fake.sessions.size).toBe(1);
  });
});
