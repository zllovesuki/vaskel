import {
  user,
  grant,
  request,
  setup,
  joined,
  publishReady,
} from "@tests/helpers/media-room";
import {
  abortAllDurableObjects,
  evictDurableObject,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AccountMediaCoordinator } from "@/server/actors/account-media/lifecycle";
import { mediaNetwork } from "@tests/helpers/media-network";

beforeAll(async () => {
  await mediaNetwork.enable();
});
afterEach(() => {
  mediaNetwork.resetHandlers();
});
afterAll(async () => {
  // Terminate isolated actors before removing their provider interception.
  await abortAllDurableObjects();
  await mediaNetwork.disable();
});

describe("media account admission on native actors", () => {
  it.each([
    ["transfer", "acceptance", "grant"],
    ["transfer", "acceptance", "principal"],
    ["transfer", "transfer-window", "grant"],
    ["transfer", "transfer-window", "principal"],
    ["leave", "acceptance", "principal"],
    ["retry", "acceptance", "grant"],
  ] as const)(
    "rejects %s when %s crosses %s expiry without changing the current participant",
    async (operation, boundary, expiry) => {
      const s = setup();
      const initial = request(s.scope);
      const accepted = joined(
        await s.account.join(s.principal, grant(s.principal, s.scope), initial),
      );
      await publishReady(s, accepted.handle);
      const providerCalls = s.fake.calls.length;
      await runInDurableObject(s.account, async (_instance, state) => {
        const originalNow = Date.now;
        const started = originalNow();
        let now = started;
        let crossed = false;
        Date.now = () => now;
        // Model an I/O boundary advancing the deployed clock. Ordinary promises
        // and SQL reads keep the same time throughout the rest of this proof.
        const storage = new Proxy(state.storage, {
          get(target, property) {
            if (property === "transaction" && boundary === "acceptance")
              return (
                callback: (tx: DurableObjectTransaction) => Promise<unknown>,
              ) =>
                target.transaction((tx) => {
                  now = started + 11;
                  crossed = true;
                  return callback(tx);
                });
            if (property === "get" && boundary === "transfer-window")
              return async (key: string) => {
                const value = await target.get(key);
                if (key === "transfer-window") {
                  now = started + 11;
                  crossed = true;
                }
                return value;
              };
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const context = new Proxy(state, {
          get(target, property) {
            if (property === "storage") return storage;
            const value: unknown = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        try {
          const before = state.storage.sql
            .exec("SELECT * FROM account_media")
            .one();
          const principal = {
            ...s.principal,
            expiresAt: started + (expiry === "principal" ? 10 : 60_000),
          };
          const authorization = {
            ...grant(principal, s.scope),
            expiresAt: started + 10,
          };
          const coordinator = new AccountMediaCoordinator(context, env);
          const result =
            operation === "leave"
              ? await coordinator.leave(principal, {
                  handle: accepted.handle,
                  commandId: crypto.randomUUID(),
                  issuedAt: started,
                })
              : operation === "retry"
                ? await coordinator.join(principal, authorization, initial)
                : await coordinator.transfer(
                    principal,
                    authorization,
                    request(s.scope, accepted.generation),
                  );
          expect(crossed).toBe(true);
          expect(result).toEqual({
            kind: expiry === "principal" ? "unauthenticated" : "unavailable",
          });
          expect(
            state.storage.sql.exec("SELECT * FROM account_media").one(),
          ).toEqual(before);
          expect(await state.storage.get("transfer-window")).toBeUndefined();
        } finally {
          Date.now = originalNow;
        }
      });
      expect(s.fake.calls).toHaveLength(providerCalls);
      expect(
        await s.media.heartbeat(s.principal, grant(s.principal, s.scope), {
          handle: accepted.handle,
        }),
      ).toMatchObject({ kind: "heartbeat" });
      expect(s.fake.calls).toHaveLength(providerCalls);
    },
  );
  it("makes simultaneous join retries retain one logical pair without allocating and status never exposes device tokens", async () => {
    const s = setup();
    const command = request(s.scope);
    const results = await Promise.all([
      s.account.join(s.principal, grant(s.principal, s.scope), command),
      s.account.join(s.principal, grant(s.principal, s.scope), command),
    ]);
    expect(results[0]).toEqual(results[1]);
    const accepted = joined(results[0]);
    expect(
      s.fake.calls.filter((call) => call.path.endsWith("/sessions/new")),
    ).toHaveLength(0);
    const status = await s.account.status(s.principal);
    expect(status).toMatchObject({
      kind: "media_status",
      generation: 1,
      admission: { kind: "transfer_required" },
    });
    expect(JSON.stringify(status)).not.toContain(command.deviceToken);
    await evictDurableObject(s.account);
    expect(
      await s.account.join(s.principal, grant(s.principal, s.scope), command),
    ).toEqual(accepted);
  });
  it("counts admission reservations and rejects participant17 without allocating its sessions", async () => {
    const s = setup();
    const people = Array.from({ length: 17 }, () => user());
    const results = await Promise.all(
      people.map((person) =>
        env.ACCOUNT_MEDIA.getByName(person.userId).join(
          person,
          grant(person, s.scope),
          request(s.scope),
        ),
      ),
    );
    expect(results.filter((result) => result.kind === "joined")).toHaveLength(
      16,
    );
    expect(results.filter((result) => result.kind === "capacity")).toHaveLength(
      1,
    );
    expect(
      s.fake.calls.filter((call) => call.path.endsWith("/sessions/new")),
    ).toHaveLength(0);
  });
  it("leaves canonical account claim state untouched when native media configuration is unavailable", async () => {
    const s = setup();
    await runInDurableObject(s.account, async (_instance, state) => {
      const coordinator = new AccountMediaCoordinator(state, {
        ...env,
        REALTIME_APP_ID: "",
        REALTIME_APP_SECRET: "",
      });
      expect(
        await coordinator.join(
          s.principal,
          grant(s.principal, s.scope),
          request(s.scope),
        ),
      ).toEqual({ kind: "unavailable" });
      expect(
        state.storage.sql.exec("SELECT * FROM account_media").toArray(),
      ).toEqual([]);
    });
    expect(s.fake.calls).toEqual([]);
  });
});
