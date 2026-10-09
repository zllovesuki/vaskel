import { barrier } from "@tests/helpers/barrier";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mediaRoomKey } from "@/server/media/authorization";
import { AccountMediaCoordinator } from "@/server/actors/account-media/lifecycle";
import type { PendingMediaCommand } from "@vaskel/contracts/media";
import { mediaNetwork } from "@tests/helpers/media-network";
import {
  grant,
  joined,
  request,
  setup,
  token,
} from "@tests/helpers/media-room";

beforeAll(() => mediaNetwork.enable());
afterEach(() => mediaNetwork.resetHandlers());
afterAll(() => mediaNetwork.disable());

function interceptCleanup(
  operation: (call: () => Promise<unknown>) => Promise<unknown>,
) {
  return new Proxy(env.MEDIA_ROOM, {
    get(namespace, property) {
      if (property !== "getByName") return Reflect.get(namespace, property);
      return (name: string) => {
        const stub = namespace.getByName(name);
        return new Proxy(stub, {
          get(stub, property) {
            if (property === "endClaim")
              return (input: Parameters<typeof stub.endClaim>[0]) =>
                operation(() => stub.endClaim(input));
            return Reflect.get(stub, property);
          },
        });
      };
    },
  });
}

async function active(fixture: ReturnType<typeof setup>) {
  return joined(
    await fixture.account.join(
      fixture.principal,
      grant(fixture.principal, fixture.scope),
      request(fixture.scope),
    ),
  );
}

async function settled(
  fixture: ReturnType<typeof setup>,
  generation: number,
  resumable = false,
) {
  await expect
    .poll(() => fixture.account.status(fixture.principal))
    .toMatchObject({
      generation,
      admission: resumable
        ? { kind: "resumable", room: fixture.scope }
        : { kind: "available" },
    });
  await expect
    .poll(() =>
      runInDurableObject(fixture.account, (_, state) =>
        state.storage.getAlarm(),
      ),
    )
    .toBeNull();
  expect(await runDurableObjectAlarm(fixture.account)).toBe(false);
}

describe("account predecessor cleanup lifetime", () => {
  it.each([false, true])(
    "bounds the caller wait and retains predecessor ownership until settlement or eviction (evict=%s)",
    async (evict) => {
      const fixture = setup();
      const accepted = await active(fixture);
      const gate = barrier();
      let calls = 0;
      let successor: number | null = null;
      const started = Date.now();
      try {
        const result = await runInDurableObject(
          fixture.account,
          async (_, state) => {
            const coordinator = new AccountMediaCoordinator(state, {
              ...env,
              MEDIA_ROOM: interceptCleanup(async (call) => {
                calls++;
                successor = await state.storage.getAlarm();
                await gate.promise;
                return call();
              }),
            });
            return coordinator.leave(fixture.principal, {
              handle: accepted.handle,
              commandId: crypto.randomUUID(),
              issuedAt: Date.now(),
            });
          },
        );
        expect(result).toMatchObject({ kind: "left", cleanupPending: true });
        expect(Date.now() - started).toBeLessThan(4_000);
        expect(successor).toBeGreaterThan(started);
        for (let pass = 0; pass < 3; pass++) {
          expect(await runDurableObjectAlarm(fixture.account)).toBe(true);
          expect(calls).toBe(1);
          await runInDurableObject(fixture.account, async (_, state) => {
            expect(await state.storage.getAlarm()).toBeGreaterThan(
              Date.now() + 500,
            );
            expect(
              state.storage.sql
                .exec(
                  "SELECT json_extract(participation, '$.cleanup.generation') AS generation FROM account_media",
                )
                .one(),
            ).toEqual({ generation: accepted.generation });
          });
        }
        // An overlapping alarm must not bypass the occupied predecessor slot.
        await runInDurableObject(fixture.media, (_, state) => {
          expect(
            state.storage.sql
              .exec("SELECT status FROM media_participants")
              .one(),
          ).toEqual({ status: "active" });
        });
        if (evict) {
          // Graceful eviction waits for RPC drainage; force interruption of the
          // isolated fixture to exercise loss of an unsettled operation.
          await abortAllDurableObjects();
          fixture.account = env.ACCOUNT_MEDIA.getByName(
            fixture.principal.userId,
          );
          fixture.media = env.MEDIA_ROOM.getByName(mediaRoomKey(fixture.scope));
          expect(await runDurableObjectAlarm(fixture.account)).toBe(true);
          await settled(fixture, accepted.generation + 1);
        }
      } finally {
        gate.release();
      }
      await settled(fixture, accepted.generation + 1);
    },
  );

  it("lets late Resume cleanup settle an inherited Leave without overwriting the newer receipt", async () => {
    const fixture = setup();
    const accepted = await active(fixture);
    const pending: PendingMediaCommand = {
      path: "resume",
      body: {
        handle: accepted.handle,
        nextDeviceToken: token(),
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      },
    };
    const gate = barrier();
    let calls = 0;
    const resuming = runInDurableObject(fixture.account, (_, state) =>
      new AccountMediaCoordinator(state, {
        ...env,
        MEDIA_ROOM: interceptCleanup(async (call) => {
          calls++;
          await gate.promise;
          return call();
        }),
      }).resume(
        fixture.principal,
        grant(fixture.principal, fixture.scope),
        pending.body,
      ),
    );
    const commandId = crypto.randomUUID();
    try {
      await expect.poll(() => calls).toBe(1);
      expect(
        await fixture.account.leave(fixture.principal, {
          pending,
          commandId,
          issuedAt: Date.now(),
        }),
      ).toMatchObject({ kind: "left", cleanupPending: true });
      expect(await runDurableObjectAlarm(fixture.account)).toBe(true);
      expect(calls).toBe(1);
    } finally {
      gate.release();
    }
    expect(await resuming).toMatchObject({
      kind: "stale_generation",
      currentGeneration: accepted.generation + 2,
    });
    await settled(fixture, accepted.generation + 2);
    await runInDurableObject(fixture.account, (_, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT json_extract(receipt, '$.commandId') AS commandId, json_extract(receipt, '$.operation') AS operation, json_extract(participation, '$.kind') AS kind, json_extract(participation, '$.reason') AS reason, json_extract(participation, '$.cleanup') AS cleanup FROM account_media",
          )
          .one(),
      ).toEqual({
        commandId,
        operation: "leave",
        kind: "left",
        reason: "left",
        cleanup: null,
      });
    });
  });

  it.each(["join", "resume"] as const)(
    "fences a held terminal reply after newer %s authority",
    async (operation) => {
      const fixture = setup();
      const accepted = await active(fixture);
      const gate = barrier();
      let entered = false;
      const resuming = runInDurableObject(fixture.account, (_, state) =>
        new AccountMediaCoordinator(state, {
          ...env,
          MEDIA_ROOM: interceptCleanup(async () => {
            entered = true;
            await gate.promise;
            return {
              kind: "closed",
              disposition: { kind: "terminal", reason: "removed" },
            };
          }),
        }).resume(fixture.principal, grant(fixture.principal, fixture.scope), {
          handle: accepted.handle,
          nextDeviceToken: token(),
          commandId: crypto.randomUUID(),
          issuedAt: Date.now(),
        }),
      );
      let newest;
      try {
        await expect.poll(() => entered).toBe(true);
        const transferred = joined(
          await fixture.account.transfer(
            fixture.principal,
            grant(fixture.principal, fixture.scope),
            request(fixture.scope, accepted.generation + 1),
          ),
        );
        if (operation === "join") {
          await fixture.account.leave(fixture.principal, {
            handle: transferred.handle,
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
          });
          newest = joined(
            await fixture.account.join(
              fixture.principal,
              grant(fixture.principal, fixture.scope),
              request(fixture.scope, transferred.generation + 1),
            ),
          );
        } else {
          newest = joined(
            await fixture.account.resume(
              fixture.principal,
              grant(fixture.principal, fixture.scope),
              {
                handle: transferred.handle,
                nextDeviceToken: token(),
                commandId: crypto.randomUUID(),
                issuedAt: Date.now(),
              },
            ),
          );
        }
      } finally {
        gate.release();
      }
      expect(await resuming).toMatchObject({
        kind: "stale_generation",
        currentGeneration: newest.generation,
      });
      expect(await fixture.account.status(fixture.principal)).toMatchObject({
        generation: newest.generation,
        admission: { kind: "transfer_required", room: fixture.scope },
      });
      await runInDurableObject(fixture.account, async (_, state) => {
        expect(await state.storage.getAlarm()).toBeNull();
        expect(
          state.storage.sql
            .exec(
              "SELECT json_extract(participation, '$.kind') AS kind, json_extract(participation, '$.reason') AS reason, json_extract(participation, '$.cleanup') AS cleanup FROM account_media",
            )
            .one(),
        ).toEqual({ kind: "active", reason: null, cleanup: null });
      });
      expect(await runDurableObjectAlarm(fixture.account)).toBe(false);
    },
  );

  it("recovers a failed predecessor RPC after eviction and retains idle intent without polling", async () => {
    const fixture = setup();
    const accepted = await active(fixture);
    const result = await runInDurableObject(fixture.account, (_, state) =>
      new AccountMediaCoordinator(state, {
        ...env,
        MEDIA_ROOM: interceptCleanup(async () => {
          throw new Error("fixture predecessor unavailable");
        }),
      }).resume(fixture.principal, grant(fixture.principal, fixture.scope), {
        handle: accepted.handle,
        nextDeviceToken: token(),
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    );
    expect(result).toMatchObject({ kind: "cleanup_pending" });
    await runInDurableObject(fixture.account, async (_, state) => {
      state.storage.sql.exec(
        "UPDATE account_media SET participation=json_set(participation, '$.deadline', 1)",
      );
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    await evictDurableObject(fixture.account);
    expect(await runDurableObjectAlarm(fixture.account)).toBe(true);
    await settled(fixture, accepted.generation + 1, true);
    expect(await fixture.account.status(fixture.principal)).toMatchObject({
      admission: { kind: "resumable", room: fixture.scope },
    });
    await runInDurableObject(fixture.account, (_, state) => {
      expect(
        state.storage.sql.exec("SELECT generation FROM account_media").one(),
      ).toEqual({ generation: accepted.generation + 1 });
    });
  });

  it("preserves a new predecessor obligation committed during an old cleanup RPC", async () => {
    const fixture = setup();
    const accepted = await active(fixture);
    const gate = barrier();
    let entered = false;
    const resuming = runInDurableObject(fixture.account, (_, state) =>
      new AccountMediaCoordinator(state, {
        ...env,
        MEDIA_ROOM: interceptCleanup(async () => {
          entered = true;
          await gate.promise;
          return {
            kind: "closed",
            disposition: { kind: "terminal", reason: "left" },
          };
        }),
      }).resume(fixture.principal, grant(fixture.principal, fixture.scope), {
        handle: accepted.handle,
        nextDeviceToken: token(),
        commandId: crypto.randomUUID(),
        issuedAt: Date.now(),
      }),
    );
    let transferred;
    try {
      await expect.poll(() => entered).toBe(true);
      transferred = joined(
        await fixture.account.transfer(
          fixture.principal,
          grant(fixture.principal, fixture.scope),
          request(fixture.scope, accepted.generation + 1),
        ),
      );
      await fixture.account.recordRemoval(
        fixture.scope,
        transferred.generation,
        "removed",
      );
    } finally {
      gate.release();
    }
    expect(await resuming).toMatchObject({ kind: "stale_generation" });
    await runInDurableObject(fixture.account, async (_, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT json_extract(participation, '$.cleanup.generation') AS generation, json_extract(participation, '$.reason') AS reason FROM account_media",
          )
          .one(),
      ).toEqual({
        generation: transferred.generation,
        reason: "removed",
      });
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now() + 500);
    });
    await runDurableObjectAlarm(fixture.account);
    await settled(fixture, transferred.generation);
  });

  it.each(["expiry", "successor"] as const)(
    "leaves local %s failure to platform recovery without an immediate alarm",
    async (failure) => {
      const fixture = setup();
      const accepted = await active(fixture);
      await runInDurableObject(fixture.account, async (_, state) => {
        const coordinator = new AccountMediaCoordinator(state, {
          ...env,
          MEDIA_ROOM: interceptCleanup(async () => {
            throw new Error("fixture predecessor unavailable");
          }),
        });
        await coordinator.resume(
          fixture.principal,
          grant(fixture.principal, fixture.scope),
          {
            handle: accepted.handle,
            nextDeviceToken: token(),
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
          },
        );
        state.storage.sql.exec(
          failure === "expiry"
            ? "UPDATE account_media SET participation=json_set(participation, '$.deadline', 1)"
            : "UPDATE account_media SET participation=json_object('kind','recovering','endpoint',json_extract(participation,'$.endpoint'),'cleanup',json_extract(participation,'$.predecessor'))",
        );
        const originalAlarm = Date.now() + 60_000;
        await state.storage.setAlarm(originalAlarm);
        const setAlarm = state.storage.setAlarm.bind(state.storage);
        const spy = vi
          .spyOn(state.storage, "setAlarm")
          .mockImplementationOnce(async (when) => {
            await setAlarm(when);
            throw new Error("fixture maintenance alarm failure");
          });
        try {
          await expect(coordinator.alarm()).rejects.toThrow(
            "fixture maintenance alarm failure",
          );
          expect(spy).toHaveBeenCalledTimes(1);
          expect(await state.storage.getAlarm()).toBe(originalAlarm);
          expect(
            state.storage.sql
              .exec(
                "SELECT json_extract(participation, '$.kind') AS kind, coalesce(json_extract(participation, '$.predecessor.generation'), json_extract(participation, '$.cleanup.generation')) AS generation FROM account_media",
              )
              .one(),
          ).toEqual({
            kind: failure === "expiry" ? "joining" : "recovering",
            generation: accepted.generation,
          });
        } finally {
          spy.mockRestore();
        }
      });
      await runDurableObjectAlarm(fixture.account);
      await settled(fixture, accepted.generation + 1, true);
    },
  );

  it("preserves predecessor recovery when clearing its settled alarm fails", async () => {
    const fixture = setup();
    const accepted = await active(fixture);
    await runInDurableObject(fixture.account, async (_, state) => {
      const deleteAlarm = state.storage.deleteAlarm.bind(state.storage);
      const spy = vi
        .spyOn(state.storage, "deleteAlarm")
        .mockImplementationOnce(async () => {
          await deleteAlarm();
          throw new Error("fixture completion alarm failure");
        });
      try {
        await expect(
          new AccountMediaCoordinator(state, env).leave(fixture.principal, {
            handle: accepted.handle,
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
          }),
        ).rejects.toThrow("fixture completion alarm failure");
        expect(spy).toHaveBeenCalledTimes(1);
        expect(
          state.storage.sql
            .exec(
              "SELECT json_extract(participation, '$.kind') AS kind, json_extract(participation, '$.cleanup.generation') AS generation FROM account_media",
            )
            .one(),
        ).toEqual({
          kind: "ending",
          generation: accepted.generation,
        });
        expect(await state.storage.getAlarm()).not.toBeNull();
      } finally {
        spy.mockRestore();
      }
    });
    expect(await runDurableObjectAlarm(fixture.account)).toBe(true);
    await settled(fixture, accepted.generation + 1);
  });

  it("rolls back a new Leave obligation when its alarm write fails", async () => {
    const fixture = setup();
    const accepted = await active(fixture);
    await runInDurableObject(fixture.account, async (_, state) => {
      const original = state.storage.setAlarm.bind(state.storage);
      const spy = vi
        .spyOn(state.storage, "setAlarm")
        .mockImplementationOnce(async (when) => {
          await original(when);
          throw new Error("fixture alarm write failure");
        });
      try {
        await expect(
          new AccountMediaCoordinator(state, env).leave(fixture.principal, {
            handle: accepted.handle,
            commandId: crypto.randomUUID(),
            issuedAt: Date.now(),
          }),
        ).rejects.toThrow("fixture alarm write failure");
      } finally {
        spy.mockRestore();
      }
      expect(
        state.storage.sql
          .exec(
            "SELECT generation, json_extract(participation, '$.kind') AS kind, json_extract(participation, '$.cleanup') AS cleanup FROM account_media",
          )
          .one(),
      ).toEqual({
        generation: accepted.generation,
        kind: "active",
        cleanup: null,
      });
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
});
