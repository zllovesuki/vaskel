import { deferred } from "@tests/shared/deferred";
import { QueryClient } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import type {
  PresenceScopeRequest,
  PresenceScopeResult,
} from "@vaskel/contracts/presence";
import type { PresenceData } from "@/client/features/presence/owner";

let PresenceOwner: typeof import("@/client/features/presence/owner").PresenceOwner;
let presenceKey: typeof import("@/client/api/presence").presenceKey;
beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  ({ PresenceOwner } = await import("@/client/features/presence/owner"));
  ({ presenceKey } = await import("@/client/api/presence"));
});
const owner: OwnerScope = { kind: "server", id: "circle" };
const userId = "viewer";
const sample = (
  scope: OwnerScope,
  nextCursor: string | null = null,
): Extract<PresenceScopeResult, { kind: "sampled" }> => ({
  kind: "sampled",
  owner: scope,
  samples: [{ userId: "person", state: "online", sampledAt: Date.now() }],
  nextCursor,
});

let client: QueryClient;
let manager: InstanceType<typeof PresenceOwner>;
let token: string;
let account: string;
let fetcher: ReturnType<
  typeof vi.fn<
    (
      scopes: PresenceScopeRequest[],
      signal: AbortSignal,
    ) => Promise<PresenceScopeResult[]>
  >
>;
const data = (scope = owner) =>
  client.getQueryData<PresenceData>(presenceKey(userId, scope));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  client = new QueryClient();
  token = "account-owner-1";
  account = "account-1";
  fetcher = vi.fn(async (scopes) => scopes.map(({ owner }) => sample(owner)));
  manager = new PresenceOwner({
    client,
    userId,
    token: () => token,
    accountCurrent: (captured) => captured === account,
    sample: fetcher,
  });
  manager.setEnabled(true, account);
});
afterEach(() => {
  manager.dispose();
  client.clear();
  vi.useRealTimers();
});
const flush = () => vi.advanceTimersByTimeAsync(10);

describe("shared visible presence sampling", () => {
  it("deduplicates mounted scopes and owns one repair cadence", async () => {
    const first = manager.register(owner);
    const second = manager.register(owner);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toEqual([{ owner }]);
    first();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    second();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(data()).toMatchObject({ samples: {}, complete: false });
  });

  it("queues fair batches of at most sixteen scopes before returning to a long roster", async () => {
    const owners = Array.from({ length: 18 }, (_, i) => ({
      kind: "server" as const,
      id: `${i}`,
    }));
    fetcher.mockImplementation(async (scopes) =>
      scopes.map((request) =>
        sample(
          request.owner,
          request.owner.id === "0" && !("after" in request && request.after)
            ? "next"
            : null,
        ),
      ),
    );
    for (const scope of owners) manager.register(scope);
    await flush();
    expect(fetcher.mock.calls.map(([scopes]) => scopes.length)).toEqual([
      16, 3,
    ]);
    expect(fetcher.mock.calls[1]![0].map(({ owner }) => owner.id)).toEqual([
      "16",
      "17",
      "0",
    ]);
    expect(fetcher.mock.calls[1]![0][2]).toEqual({
      owner: owners[0],
      after: "next",
    });
    expect(data(owners[0])).toMatchObject({ complete: true });
  });

  it("keeps a trailing hint after the current paginated scan without starving later members", async () => {
    const held = deferred<PresenceScopeResult[]>();
    fetcher.mockReturnValueOnce(held.promise);
    manager.register(owner);
    await flush();
    for (let i = 0; i < 20; i++) manager.refresh(owner, "person");
    held.resolve([sample(owner, "next")]);
    await flush();
    expect(
      fetcher.mock.calls.map(([scopes]) =>
        scopes[0] && "after" in scopes[0] ? scopes[0].after : undefined,
      ),
    ).toEqual([undefined, "next", undefined]);
  });

  it("merges only targeted members, clears absent members and limits unknown state to a failed selection", async () => {
    manager.register(owner);
    await flush();
    fetcher.mockResolvedValueOnce([
      {
        ...sample(owner),
        samples: [
          { userId: "another", state: "offline", sampledAt: Date.now() },
        ],
      },
    ]);
    manager.refresh(owner, "another");
    await flush();
    expect(fetcher.mock.calls.at(-1)![0]).toEqual([
      { owner, userIds: ["another"] },
    ]);
    expect(data()?.samples.person?.state).toBe("online");
    expect(data()?.samples.another?.state).toBe("offline");
    expect(data()?.complete).toBe(true);
    fetcher.mockRejectedValueOnce(new Error("unavailable"));
    manager.refresh(owner, "another");
    await flush();
    expect(data()?.samples.another?.state).toBe("unknown");
    expect(data()?.samples.person?.state).toBe("online");
    fetcher.mockResolvedValueOnce([{ ...sample(owner), samples: [] }]);
    manager.refresh(owner, "another");
    await flush();
    expect(data()?.samples.another).toBeUndefined();
    fetcher.mockResolvedValueOnce([{ kind: "denied", owner }]);
    manager.refresh(owner, "person");
    await flush();
    expect(data()).toMatchObject({ samples: {}, complete: false });
  });

  it("samples one changed member after eight pages of a 500-member circle and coalesces bounded hidden hints", async () => {
    const members = Array.from({ length: 500 }, (_, index) =>
      String(index).padStart(3, "0"),
    );
    let sampled = 0;
    fetcher.mockImplementation(async (scopes) =>
      scopes.map((request) => {
        const selected =
          "userIds" in request
            ? request.userIds
            : members
                .filter((id) => !request.after || id > request.after)
                .slice(0, 64);
        sampled += selected.length;
        return {
          kind: "sampled",
          owner: request.owner,
          samples: selected.map((userId) => ({
            userId,
            state: "online",
            sampledAt: Date.now(),
          })),
          nextCursor:
            "userIds" in request || selected.at(-1) === members.at(-1)
              ? null
              : selected.at(-1)!,
        };
      }),
    );
    const remove = manager.register(owner);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect(sampled).toBe(500);
    for (let index = 0; index < 20; index++) manager.refresh(owner, "001");
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(sampled).toBe(501);
    manager.setEnabled(false);
    for (const userId of members) manager.refresh(owner, userId);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(9);
    manager.refresh(owner, "overflow");
    manager.setEnabled(true, account);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(17);
    expect(sampled).toBe(1001);
    remove();
    manager.refresh(owner, "001");
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(17);
  });

  it("defers hints and continuations while hidden, then coalesces a fresh read on return", async () => {
    const held = deferred<PresenceScopeResult[]>();
    fetcher.mockReturnValueOnce(held.promise);
    manager.register(owner);
    await flush();
    manager.setEnabled(false);
    manager.refresh(owner);
    held.resolve([sample(owner, "next")]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(data()?.samples.person?.state).toBe("unknown");
    manager.setEnabled(true, account);
    await flush();
    expect(
      fetcher.mock.calls.map(([scopes]) =>
        scopes[0] && "after" in scopes[0] ? scopes[0].after : undefined,
      ),
    ).toEqual([undefined, "next", undefined]);
    expect(data()?.samples.person?.state).toBe("online");
  });

  it.each(["remove", "deny", "account"] as const)(
    "rejects late pages after %s",
    async (change) => {
      const held = deferred<PresenceScopeResult[]>();
      fetcher.mockReturnValueOnce(held.promise);
      const remove = manager.register(owner);
      await flush();
      if (change === "remove") remove();
      else if (change === "deny") {
        manager.setDenied(["server:circle"]);
        token = "denied";
      } else manager.dispose();
      held.resolve([sample(owner, "next")]);
      await flush();
      expect(data()?.samples.person).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects an old owner epoch and restarts without its continuation", async () => {
    const held = deferred<PresenceScopeResult[]>();
    fetcher
      .mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce([{ kind: "unavailable", owner }]);
    manager.register(owner);
    await flush();
    token = "new-owner-epoch";
    held.resolve([sample(owner, "old-page")]);
    await flush();
    expect(
      fetcher.mock.calls.map(([scopes]) =>
        scopes[0] && "after" in scopes[0] ? scopes[0].after : undefined,
      ),
    ).toEqual([undefined, undefined]);
    expect(data()?.samples.person).toBeUndefined();
  });

  it("does not restore a removed scope when it is mounted again before its old page settles", async () => {
    const held = deferred<PresenceScopeResult[]>();
    fetcher
      .mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce([{ kind: "unavailable", owner }]);
    const remove = manager.register(owner);
    await flush();
    remove();
    manager.register(owner);
    held.resolve([sample(owner)]);
    await flush();
    expect(data()?.samples.person).toBeUndefined();
  });

  it("retains scoped partial successes, clears failures to unknown and recovers on a later hint", async () => {
    const other: OwnerScope = { kind: "conversation", id: "dm" };
    manager.register(owner);
    manager.register(other);
    await flush();
    fetcher.mockResolvedValueOnce([
      sample(owner),
      { kind: "unavailable", owner: other },
    ]);
    manager.refresh();
    await flush();
    expect(data()?.samples.person?.state).toBe("online");
    expect(data(other)).toMatchObject({ samples: {}, complete: false });
    fetcher.mockRejectedValueOnce(new Error("hub down"));
    manager.refresh(owner);
    await flush();
    expect(data()).toMatchObject({ samples: {}, complete: false });
    manager.refresh();
    await flush();
    expect(data()?.samples.person?.state).toBe("online");
    expect(data(other)?.samples.person?.state).toBe("online");
  });

  it.each([false, true])(
    "keeps account purge complete through unregister and disposal (%s)",
    async (disposeFirst) => {
      const unregister = manager.register(owner);
      await flush();
      client.removeQueries({ queryKey: ["private"] });
      account = "replacement-account";
      if (disposeFirst) manager.dispose();
      unregister();
      await flush();
      expect(client.getQueryCache().getAll()).toHaveLength(0);
    },
  );

  it("does not restart or restore a late read after synchronous account retirement", async () => {
    const held = deferred<PresenceScopeResult[]>();
    manager.register(owner);
    await flush();
    fetcher.mockReturnValueOnce(held.promise);
    manager.refresh();
    await flush();
    client.removeQueries({ queryKey: ["private"] });
    account = "replacement-account";
    token = "replacement-owner";
    held.resolve([sample(owner, "next")]);
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("expires samples after ninety seconds even with a stalled repair", async () => {
    manager.register(owner);
    await flush();
    fetcher.mockReturnValueOnce(new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(data()?.samples.person?.state).toBe("unknown");
  });
});
