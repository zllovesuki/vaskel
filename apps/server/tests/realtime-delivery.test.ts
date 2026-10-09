import { describe, expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { BoundedWork, actorWork } from "@/server/actors/shared/bounded-work";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import { notifyDirectory } from "@/server/actors/shared/event-notices";
import {
  drainMediaInvalidations,
  queueMediaInvalidations,
} from "@/server/actors/shared/media-invalidations";
import { EVENT_DISPATCH_RECIPIENT_LIMIT } from "@/server/event-dispatch/limits";
import { groupEventDispatchRecipients } from "@/server/event-dispatch/routing";
import { applicationHarness } from "@tests/helpers/application-harness";

describe("bounded actor delivery", () => {
  it("keeps timed-out work in its slot across later passes and releases it only on settlement", async () => {
    const pool = new BoundedWork(1, 5);
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let starts = 0;
    expect(
      await pool.run(async () => {
        starts++;
        await delayed;
      }, Date.now() + 1_000),
    ).toEqual({ ok: false });
    expect(
      await pool.map(
        [1, 2, 3],
        async () => {
          starts++;
        },
        Date.now() + 20,
      ),
    ).toEqual([{ ok: false }, { ok: false }, { ok: false }]);
    expect(starts).toBe(1);
    release();
    await vi.waitFor(async () => {
      expect(await pool.run(async () => "resumed", Date.now() + 1_000)).toEqual(
        { ok: true, value: "resumed" },
      );
    });
  });

  it("waits for capacity across overlapping maps and timeouts without releasing occupied slots", async () => {
    const pool = new BoundedWork(2, 10);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: number[] = [];
    const first = pool.map(
      [1, 2, 3],
      async (entry) => {
        calls.push(entry);
        if (entry < 3) await blocked;
        return entry;
      },
      Date.now() + 1_000,
      String,
    );
    await vi.waitFor(() => expect(calls).toEqual([1, 2]));
    // Direct cleanup retains immediate refusal, including a duplicate key.
    expect(await pool.run(async () => 1, Date.now() + 1_000, "1")).toEqual({
      ok: false,
    });
    const second = pool.map(
      [4, 5],
      async (entry) => {
        calls.push(entry);
        return entry;
      },
      Date.now() + 1_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toEqual([1, 2]);
    release();
    expect(await first).toEqual([
      { ok: false },
      { ok: false },
      { ok: true, value: 3 },
    ]);
    expect(await second).toEqual([
      { ok: true, value: 4 },
      { ok: true, value: 5 },
    ]);
  });

  it("returns from committed directory publication while a recipient is delayed, with a shared bound across publications", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    await runInDurableObject(
      h.environment.SERVER_DO.getByName(server.owner.id),
      async (_instance, state) => {
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        let calls = 0;
        const environment = {
          ...h.environment,
          EVENT_DISPATCH: {
            getByName: () => ({
              deliver: async () => {
                calls++;
                await pending;
              },
            }),
          } as unknown as Env["EVENT_DISPATCH"],
        };
        try {
          const database = openOwnerDatabase(state.storage);
          // Every invocation settles even though no recipient RPC has settled.
          for (let i = 0; i < 20; i++)
            await notifyDirectory(state, environment, database);
          expect(calls).toBeGreaterThan(0);
          expect(calls).toBeLessThanOrEqual(8);
        } finally {
          release();
        }
        await vi.waitFor(async () => {
          expect(
            await actorWork(state.storage, "hints").run(
              async () => true,
              Date.now() + 1_000,
            ),
          ).toEqual({ ok: true, value: true });
        });
      },
    );
  });

  it("chunks native audience reads and rechecks membership after earlier hub batches suspend", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    await runInDurableObject(
      h.environment.SERVER_DO.getByName(server.owner.id),
      async (_instance, state) => {
        for (let index = 0; index < EVENT_DISPATCH_RECIPIENT_LIMIT * 9; index++)
          state.storage.sql.exec(
            "INSERT INTO members (user_id,role) VALUES (?,'member')",
            crypto.randomUUID(),
          );
        const database = openOwnerDatabase(state.storage);
        const users = (
          await database.selectFrom("members").select("user_id").execute()
        ).map((row) => row.user_id);
        const groups = groupEventDispatchRecipients(users);
        expect(groups.length).toBeGreaterThan(8);
        const removed = new Set(groups.at(-1)!.recipients);
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        const deliveries: string[][] = [];
        const environment = {
          ...h.environment,
          EVENT_DISPATCH: {
            getByName: () => ({
              deliver: async ({ recipients }: { recipients: string[] }) => {
                deliveries.push(recipients);
                await pending;
              },
            }),
          } as unknown as Env["EVENT_DISPATCH"],
        };
        // Creation's detached directory hint can still occupy a slot on entry.
        await vi.waitFor(async () => {
          expect(
            await actorWork(state.storage, "hints").map(
              Array.from({ length: 8 }),
              async () => true,
            ),
          ).toEqual(
            Array.from({ length: 8 }, () => ({ ok: true, value: true })),
          );
        });
        try {
          await notifyDirectory(state, environment, database);
          await vi.waitFor(() => expect(deliveries).toHaveLength(8));
          for (const userId of removed)
            state.storage.sql.exec(
              "DELETE FROM members WHERE user_id=?",
              userId,
            );
        } finally {
          release();
        }
        await vi.waitFor(() =>
          expect(deliveries.flat()).toHaveLength(users.length - removed.size),
        );
        expect(deliveries.flat().some((userId) => removed.has(userId))).toBe(
          false,
        );
        expect(
          deliveries.every(
            (recipients) => recipients.length <= EVENT_DISPATCH_RECIPIENT_LIMIT,
          ),
        ).toBe(true);
      },
    );
  });

  it("returns durable invalidation work after timeout without acknowledging a late response over a newer generation", async () => {
    const h = applicationHarness();
    const operator = await h.bootstrap();
    const server = await h.createServer(operator);
    await runInDurableObject(
      h.environment.SERVER_DO.getByName(server.owner.id),
      async (_instance, state) => {
        const database = openOwnerDatabase(state.storage);
        await queueMediaInvalidations(
          state.storage,
          database,
          [server.channelId],
          operator.profile!.userId,
          1,
        );
        await state.storage.setAlarm(Date.now() + 60_000);
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        try {
          await drainMediaInvalidations(state, database, async () => {
            await pending;
            return { kind: "closed" };
          });
          expect(
            state.storage.sql
              .exec<{ count: number }>(
                "SELECT COUNT(*) AS count FROM media_invalidations",
              )
              .one().count,
          ).toBe(1);
          expect(await state.storage.getAlarm()).not.toBeNull();
          await queueMediaInvalidations(
            state.storage,
            database,
            [server.channelId],
            operator.profile!.userId,
            2,
          );
          await state.storage.setAlarm(Date.now() + 60_000);
        } finally {
          release();
        }
        await vi.waitFor(async () => {
          expect(
            await actorWork(state.storage, "maintenance").run(
              async () => true,
              Date.now() + 1_000,
            ),
          ).toEqual({ ok: true, value: true });
        });
        expect(
          state.storage.sql
            .exec<{ permission_generation: number }>(
              "SELECT permission_generation FROM media_invalidations",
            )
            .one().permission_generation,
        ).toBe(2);
        await drainMediaInvalidations(state, database, async () => ({
          kind: "closed",
        }));
        expect(
          state.storage.sql
            .exec<{ count: number }>(
              "SELECT COUNT(*) AS count FROM media_invalidations",
            )
            .one().count,
        ).toBe(0);
      },
    );
  });
});
