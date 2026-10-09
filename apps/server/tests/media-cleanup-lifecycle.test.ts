import { barrier } from "@tests/helpers/barrier";
import {
  abortAllDurableObjects,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  mediaNetwork,
  mediaNetworkProbe,
  useMediaSfu,
} from "@tests/helpers/media-network";
import { createMediaSfu } from "@tests/fixtures/media-sfu";
import {
  alarmMediaRoom,
  scheduleMediaAlarm,
} from "@/server/actors/media/alarm";
import {
  closeParticipant,
  markParticipantClosing,
} from "@/server/actors/media/cleanup";
import { allocationScope } from "@/server/actors/media/operations";
import {
  MEDIA_TERMINAL_RETENTION_MS,
  pruneMediaRecords,
} from "@/server/actors/media/retention";
import {
  ensureRoom,
  openMediaDatabase,
  type RoomRuntime,
} from "@/server/actors/media/store";
import { RealtimeClient, RealtimeError } from "@/server/providers/realtime";
import { room } from "@tests/helpers/media-room";

beforeAll(() => mediaNetwork.enable());
beforeEach(() => useMediaSfu(createMediaSfu()));
afterEach(() => {
  mediaNetwork.resetHandlers();
  expect(mediaNetworkProbe.blocked).toBe(0);
  expect(mediaNetworkProbe.dispatched).toBe(0);
});
afterAll(() => mediaNetwork.disable());

function fixture() {
  return env.MEDIA_ROOM.getByName(crypto.randomUUID());
}

async function runtime(ctx: DurableObjectState): Promise<RoomRuntime> {
  const rt: RoomRuntime = {
    ctx,
    env,
    db: openMediaDatabase(ctx.storage),
    provider: new RealtimeClient(env),
    inflight: new Map(),
  };
  await ensureRoom(rt, room());
  return rt;
}

function insert(
  rt: RoomRuntime,
  id = "p",
  status = "active",
  cleanupAt: number | null = null,
) {
  rt.ctx.storage.sql.exec(
    `INSERT INTO media_participants(id,generation,user_id,session_id,client_id,token_hash,status,lease_expires,permission_generation,reason,cleanup_at)
     VALUES(?,1,?,'session','client','hash',?,?,1,?,?)`,
    id,
    id,
    status,
    Date.now() + 60_000,
    status === "closing" ? "leave" : null,
    cleanupAt,
  );
  for (const direction of ["producer", "consumer"])
    rt.ctx.storage.sql.exec(
      `INSERT INTO media_sessions(session_key,participant_id,generation,direction,provider_id,version,phase,operation_id,deadline)
       VALUES(?,?,1,?,?,1,'awaiting_apply','op',1)`,
      `${id}:1:${direction}`,
      id,
      direction,
      `${id}-${direction}`,
    );
}

async function runPass(rt: RoomRuntime) {
  // The helper executes the native actor logic without an automatic immediate
  // alarm racing assertions; synthetic rows decide which domains are due.
  await rt.ctx.storage.setAlarm(Date.now() + 60_000);
  await alarmMediaRoom(rt);
}

describe("media cleanup scheduling on native storage", () => {
  it("rolls back closure authority and the cleanup obligation if the alarm write fails", async () => {
    const stub = fixture();
    await runInDurableObject(stub, async (_instance, ctx) =>
      ctx.blockConcurrencyWhile(async () => {
        const rt = await runtime(ctx);
        insert(rt);
        const write = vi
          .spyOn(ctx.storage, "setAlarm")
          .mockRejectedValueOnce(new Error("alarm unavailable"));
        try {
          await expect(
            ctx.storage.transaction(() =>
              markParticipantClosing(rt, { id: "p", generation: 1 }, "leave"),
            ),
          ).rejects.toThrow("alarm unavailable");
        } finally {
          write.mockRestore();
        }
        expect(
          ctx.storage.sql
            .exec("SELECT status,reason,cleanup_at FROM media_participants")
            .one(),
        ).toEqual({ status: "active", reason: null, cleanup_at: null });
        expect(await ctx.storage.getAlarm()).toBeNull();
        const priorWake = Date.now() + 30_000;
        await ctx.storage.setAlarm(priorWake);
        const failedClaim = vi
          .spyOn(ctx.storage, "setAlarm")
          .mockRejectedValueOnce(new Error("claim alarm unavailable"));
        try {
          await expect(alarmMediaRoom(rt)).rejects.toThrow(
            "claim alarm unavailable",
          );
        } finally {
          failedClaim.mockRestore();
        }
        expect(await ctx.storage.getAlarm()).toBe(priorWake);
        expect(
          ctx.storage.sql
            .exec("SELECT status,cleanup_at FROM media_participants")
            .one(),
        ).toEqual({ status: "active", cleanup_at: null });
        await ctx.storage.deleteAlarm();
      }),
    );
  });

  it("expires a generation once, retries by cleanup time, and stops after pruning while retaining its fence", async () => {
    const stub = fixture();
    await runInDurableObject(stub, async (_instance, ctx) =>
      ctx.blockConcurrencyWhile(async () => {
        const rt = await runtime(ctx);
        insert(rt);
        let inspections = 0;
        let fail = true;
        rt.provider.getSession = async () => {
          inspections++;
          return { tracks: [{ mid: "0" }] };
        };
        rt.provider.closeTracks = async () => {
          if (fail)
            throw new RealtimeError("fixture unavailable", 503, true, true);
          return {
            tracks: [{ mid: "0" }],
            requiresImmediateRenegotiation: false,
          };
        };
        for (let pass = 1; pass <= 3; pass++) {
          ctx.storage.sql.exec(
            "UPDATE media_participants SET cleanup_at=1 WHERE cleanup_at IS NOT NULL",
          );
          const before = Date.now();
          await runPass(rt);
          expect(inspections).toBe(pass * 2);
          const p = await rt.db
            .selectFrom("media_participants")
            .selectAll()
            .executeTakeFirstOrThrow();
          expect(p).toMatchObject({
            status: "closing",
            reason: "negotiation_expired",
          });
          expect(p.cleanup_at).toBeGreaterThanOrEqual(before + 1_000);
          expect(await ctx.storage.getAlarm()).toBe(p.cleanup_at);
          // An unrelated alarm before eligibility cannot retry the old deadlines.
          await runPass(rt);
          expect(inspections).toBe(pass * 2);
        }
        fail = false;
        ctx.storage.sql.exec("UPDATE media_participants SET cleanup_at=1");
        await runPass(rt);
        expect(
          ctx.storage.sql
            .exec("SELECT status,cleanup_at FROM media_participants")
            .one(),
        ).toEqual({ status: "left", cleanup_at: null });
        ctx.storage.sql.exec(
          "UPDATE media_participants SET closed_at=?",
          Date.now() - MEDIA_TERMINAL_RETENTION_MS,
        );
        await runPass(rt);
        expect(
          ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM media_sessions").one()
            .n,
        ).toBe(0);
        expect(
          ctx.storage.sql
            .exec("SELECT COUNT(*) AS n FROM media_participants")
            .one().n,
        ).toBe(1);
        expect(await ctx.storage.getAlarm()).toBeNull();
      }),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("advances failed and still-running candidates so a later batch progresses without overlapping the held attempt", async () => {
    const stub = fixture();
    await runInDurableObject(stub, async (_instance, ctx) =>
      ctx.blockConcurrencyWhile(async () => {
        const rt = await runtime(ctx);
        for (let index = 0; index < 20; index++)
          insert(rt, `p${String(index).padStart(2, "0")}`, "closing", 1);
        const held = barrier();
        const inspected: string[] = [];
        rt.provider.getSession = async (id) => {
          inspected.push(id);
          if (id === "p00-producer" || id === "p01-producer")
            await held.promise;
          if (id.startsWith("p02"))
            throw new RealtimeError("fixture unavailable", 503, true, true);
          return { tracks: [] };
        };
        try {
          const start = Date.now();
          await runPass(rt);
          expect(Date.now() - start).toBeLessThan(6_000);
          expect(
            ctx.storage.sql
              .exec<{ cleanup_at: number }>(
                "SELECT cleanup_at FROM media_participants WHERE id='p00'",
              )
              .one().cleanup_at,
          ).toBeGreaterThanOrEqual(Date.now() + 900);
          expect(rt.inflight.has("cleanup:p00:1")).toBe(true);
          await runPass(rt);
          expect(inspected.some((id) => id.startsWith("p16"))).toBe(true);
          expect(inspected.filter((id) => id === "p00-producer")).toHaveLength(
            1,
          );
          expect(
            ctx.storage.sql
              .exec("SELECT cleanup_at FROM media_participants WHERE id='p00'")
              .one().cleanup_at,
          ).not.toBeNull();
        } finally {
          held.release();
          await Promise.allSettled([...rt.inflight.values()]);
        }
        expect(
          ctx.storage.sql
            .exec(
              "SELECT status,cleanup_at FROM media_participants WHERE id='p00'",
            )
            .one(),
        ).toEqual({ status: "left", cleanup_at: null });
        await ctx.storage.deleteAlarm();
      }),
    );
  });

  it("retains all four unsettled slots after caller timeout and admits more work only after settlement", async () => {
    const stub = fixture();
    await runInDurableObject(stub, async (_instance, ctx) =>
      ctx.blockConcurrencyWhile(async () => {
        const rt = await runtime(ctx);
        for (let i = 0; i < 5; i++) insert(rt, `held${i}`, "closing", 1);
        const gate = barrier();
        const calls: string[] = [];
        rt.provider.getSession = async (id) => {
          calls.push(id);
          await gate.promise;
          return { tracks: [] };
        };
        const participants = await rt.db
          .selectFrom("media_participants")
          .selectAll()
          .orderBy("id")
          .execute();
        try {
          expect(
            await Promise.all(
              participants
                .slice(0, 4)
                .map((p) => closeParticipant(rt, p, "leave")),
            ),
          ).toEqual([false, false, false, false]);
          expect(rt.inflight.size).toBe(4);
          expect(await closeParticipant(rt, participants[4]!, "leave")).toBe(
            false,
          );
          expect(calls.some((id) => id.startsWith("held4"))).toBe(false);
        } finally {
          gate.release();
          await Promise.allSettled([...rt.inflight.values()]);
        }
        expect(await closeParticipant(rt, participants[4]!, "leave")).toBe(
          true,
        );
        expect(calls.some((id) => id.startsWith("held4"))).toBe(true);
        await ctx.storage.deleteAlarm();
      }),
    );
  });

  it("refreshes fresh state after external I/O and keeps an occupancy lease's exact deadline", async () => {
    const stub = fixture();
    await runInDurableObject(stub, async (_instance, ctx) =>
      ctx.blockConcurrencyWhile(async () => {
        const rt = await runtime(ctx);
        insert(rt, "old", "closing", 1);
        let added = false;
        rt.provider.getSession = async () => {
          if (!added) {
            added = true;
            await ctx.storage.transaction(async () => {
              insert(rt, "new");
              ctx.storage.sql.exec(
                "UPDATE media_sessions SET deadline=0 WHERE participant_id='new'",
              );
              await markParticipantClosing(
                rt,
                { id: "new", generation: 1 },
                "leave",
              );
            });
          }
          return { tracks: [] };
        };
        await runPass(rt);
        expect(
          ctx.storage.sql
            .exec("SELECT cleanup_at FROM media_participants WHERE id='new'")
            .one().cleanup_at,
        ).not.toBeNull();
        expect(await ctx.storage.getAlarm()).not.toBeNull();
        ctx.storage.sql.exec(
          "UPDATE media_participants SET cleanup_at=1 WHERE id='new'",
        );
        await runPass(rt);
        const lease = Date.now() + 500;
        ctx.storage.sql.exec(
          "UPDATE media_occupancy SET next_attempt_at=1,lease_id='held',lease_expires_at=?",
          lease,
        );
        await scheduleMediaAlarm(rt);
        expect(await ctx.storage.getAlarm()).toBe(lease);
        await ctx.storage.deleteAlarm();
      }),
    );
  });

  it("skips protected retention candidates before the batch limit and retains a durable wake until they settle", async () => {
    const stub = fixture();
    await runInDurableObject(stub, async (_instance, ctx) =>
      ctx.blockConcurrencyWhile(async () => {
        const rt = await runtime(ctx);
        const release: (() => void)[] = [];
        for (let index = 0; index < 18; index++) {
          const id = `p${index}`;
          insert(rt, id, "left");
          ctx.storage.sql.exec(
            "UPDATE media_participants SET reason='transfer',closed_at=1 WHERE id=?",
            id,
          );
          if (index < 17) release.push(allocationScope(rt, `${id}:1:producer`));
        }
        pruneMediaRecords(rt, Date.now());
        expect(
          ctx.storage.sql
            .exec(
              "SELECT COUNT(*) AS n FROM media_sessions WHERE participant_id='p17'",
            )
            .one().n,
        ).toBe(0);
        await scheduleMediaAlarm(rt);
        expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
        for (const done of release) done();
        expect(await ctx.storage.getAlarm()).not.toBeNull();
        await runPass(rt);
        await runPass(rt);
        expect(await ctx.storage.getAlarm()).toBeNull();
        expect(
          ctx.storage.sql
            .exec("SELECT COUNT(*) AS n FROM media_participants")
            .one().n,
        ).toBe(18);
      }),
    );
  });

  it("prunes protected transfer details after interruption without a scope release or later room traffic", async () => {
    const name = crypto.randomUUID();
    let stub = env.MEDIA_ROOM.getByName(name);
    await runInDurableObject(stub, async (_instance, ctx) =>
      ctx.blockConcurrencyWhile(async () => {
        const rt = await runtime(ctx);
        insert(rt, "interrupted", "left");
        ctx.storage.sql.exec(
          "UPDATE media_participants SET reason='transfer',closed_at=1",
        );
        // The scope is intentionally never released: forced actor interruption
        // must recover from the committed alarm, without its in-memory finally.
        allocationScope(rt, "interrupted:1:producer");
        pruneMediaRecords(rt, Date.now());
        expect(
          ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM media_sessions").one()
            .n,
        ).toBe(2);
        await scheduleMediaAlarm(rt);
        expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
      }),
    );
    await abortAllDurableObjects();
    stub = env.MEDIA_ROOM.getByName(name);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, ctx) => {
      expect(
        ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM media_sessions").one()
          .n,
      ).toBe(0);
      expect(
        ctx.storage.sql
          .exec("SELECT status,cleanup_at FROM media_participants")
          .one(),
      ).toEqual({ status: "left", cleanup_at: null });
      expect(await ctx.storage.getAlarm()).toBeNull();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });

  it("propagates unexpected cleanup failure while retaining its durable successor", async () => {
    const stub = fixture();
    await runInDurableObject(stub, async (_instance, ctx) =>
      ctx.blockConcurrencyWhile(async () => {
        const rt = await runtime(ctx);
        insert(rt, "failed", "closing", 1);
        rt.provider.getSession = async () => {
          throw new Error("local invariant failure");
        };
        const p = await rt.db
          .selectFrom("media_participants")
          .selectAll()
          .executeTakeFirstOrThrow();
        await expect(closeParticipant(rt, p, "leave")).rejects.toThrow(
          "local invariant failure",
        );
        expect(
          ctx.storage.sql
            .exec(
              "SELECT status,cleanup_at IS NOT NULL AS pending FROM media_participants",
            )
            .one(),
        ).toEqual({ status: "closing", pending: 1 });
        expect(await ctx.storage.getAlarm()).not.toBeNull();
        await ctx.storage.deleteAlarm();
      }),
    );
  });
});
