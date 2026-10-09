import { deferred } from "@tests/shared/deferred";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { OwnerActivity } from "@vaskel/contracts/activity";
import type { ResourceSummary } from "@vaskel/contracts/directory";
import type { AccountEventFrame } from "@vaskel/contracts/account-events";

let api: typeof import("@/client/api/client");
let apply: typeof import("@/client/features/account-events/apply");
let activity: typeof import("@/client/api/activity");
let blocks: typeof import("@/client/api/blocks");
let notifications: typeof import("@/client/api/notifications");
beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  api = await import("@/client/api/client");
  apply = await import("@/client/features/account-events/apply");
  activity = await import("@/client/api/activity");
  blocks = await import("@/client/api/blocks");
  notifications = await import("@/client/api/notifications");
});

const userId = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const owner = { kind: "server" as const, id: "circle" };
const generation = "00000000-0000-4000-8000-00000000000a";
const channelId = "general";
function ownerState(unreadCount = 0, last = 5, read = 5): OwnerActivity {
  return {
    owner,
    generation,
    channels: [
      {
        channelId,
        lastCreatedSequence: last,
        readSequence: read,
        unreadCount,
        mentionCount: 0,
        hasUnread: unreadCount > 0,
      },
    ],
    nextCursor: null,
  };
}
const resource: ResourceSummary = {
  owner,
  name: "Weekend regulars",
  version: 1,
  role: "member",
  membersMayInvite: true,
  canCreateInvite: true,
  channels: [
    {
      id: "lounge",
      name: "Lounge",
      kind: "media",
      private: false,
      version: 1,
      topic: null,
      position: 0,
      occupancy: null,
    },
  ],
};
let client: QueryClient;
let effects: import("@/client/features/account-events/apply").AccountEventEffects;
let memory: InstanceType<typeof apply.NoticeMemory>;
function seedActivity(state = ownerState()) {
  client.setQueryData(activity.accountActivityKey(userId), {
    pages: [
      {
        kind: "activity",
        owners: [state],
        unavailableOwners: [],
        partial: false,
        nextCursor: null,
      },
    ],
    pageParams: [null],
  });
}
function seedDirectory() {
  client.setQueryData(api.directoryKey(userId), {
    pages: [
      {
        kind: "directory",
        resources: [resource],
        canCreateServers: false,
        partial: false,
        nextCursor: null,
      },
    ],
    pageParams: [null],
  });
}
const channel = () =>
  client.getQueryData<{ pages: { owners: OwnerActivity[] }[] }>(
    activity.accountActivityKey(userId),
  )!.pages[0]!.owners[0]!.channels[0]!;
const invalidated = (key: readonly unknown[]) =>
  client.getQueryState(key)?.isInvalidated === true;

async function run(notice: AccountEventFrame, now = Date.now()) {
  vi.setSystemTime(now);
  const result = apply.applyAccountEvent(
    client,
    userId,
    notice,
    memory,
    effects,
    now,
  );
  await vi.advanceTimersByTimeAsync(0);
  return result;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  vi.stubGlobal("document", { visibilityState: "visible" });
  effects = {
    contentChanged: vi.fn(),
    resync: vi.fn(),
    presenceChanged: vi.fn(),
    callChanged: vi.fn(async () => {}),
    messageArrived: vi.fn(),
  };
  client = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false } },
  });
  memory = new apply.NoticeMemory();
});

describe("hidden metadata refreshes", () => {
  function observe(key: readonly unknown[], fetcher = vi.fn(async () => 1)) {
    client.setQueryData(key, 0);
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: fetcher,
      staleTime: Infinity,
      retry: false,
    });
    return { fetcher, observer, stop: observer.subscribe(() => {}) };
  }
  function hidden(value: boolean) {
    vi.stubGlobal("document", {
      visibilityState: value ? "hidden" : "visible",
    });
  }
  const mutation = (sequence: number): AccountEventFrame => ({
    type: "mutation",
    owner,
    channelId,
    generation,
    sequence,
  });

  it("coalesces hidden hints without timers while retiring content immediately", async () => {
    const watched = observe(activity.accountActivityKey(userId));
    try {
      hidden(true);
      const timers = vi.getTimerCount();
      for (let sequence = 1; sequence <= 20; sequence++)
        await run(mutation(sequence));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(watched.fetcher).not.toHaveBeenCalled();
      expect(effects.contentChanged).toHaveBeenCalledTimes(20);
      expect(vi.getTimerCount()).toBe(timers);
      hidden(false);
      memory.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(watched.fetcher).toHaveBeenCalledOnce();
      memory.resume();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(watched.fetcher).toHaveBeenCalledOnce();
      hidden(true);
      await run(mutation(21));
      hidden(false);
      memory.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(watched.fetcher).toHaveBeenCalledTimes(2);
    } finally {
      watched.stop();
    }
  });

  it.each([false, true])(
    "retains a pre-hint trailing read across hiding unless disposed (%s)",
    async (dispose) => {
      const held = deferred<number>();
      const fetcher = vi
        .fn()
        .mockReturnValueOnce(held.promise)
        .mockResolvedValue(2);
      const watched = observe(activity.accountActivityKey(userId), fetcher);
      try {
        void watched.observer.refetch();
        await run(mutation(1));
        hidden(true);
        held.resolve(1);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetcher).toHaveBeenCalledOnce();
        if (dispose) memory.dispose();
        hidden(false);
        memory.resume();
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(dispose ? 1 : 2);
      } finally {
        watched.stop();
      }
    },
  );

  it("routes presence hints to the shared owner without invalidating membership", async () => {
    const key = api.membersKey(userId, owner);
    client.setQueryData(key, 0);
    hidden(true);
    await run({ type: "presence", owner, userId: other });
    expect(effects.presenceChanged).toHaveBeenCalledWith(owner, other);
    expect(invalidated(key)).toBe(false);
  });

  it("settles a failed resumed refresh without retry loops and accepts the next hint", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error("Metadata unavailable"))
      .mockResolvedValue(2);
    const key = api.directoryKey(userId);
    const watched = observe(key, fetcher);
    try {
      hidden(true);
      await run({ type: "occupancy", owner, channelId: "lounge" });
      hidden(false);
      memory.resume();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(watched.observer.getCurrentResult().isError).toBe(true);
      hidden(true);
      await run({ type: "occupancy", owner, channelId: "lounge" }, Date.now());
      hidden(false);
      memory.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(client.getQueryData(key)).toBe(2);
    } finally {
      watched.stop();
    }
  });

  it("keeps ready resync, call refresh, pre-join and administration work immediate", async () => {
    const administration = await import("@/client/api/administration");
    const metadata = [
      api.directoryKey(userId),
      activity.accountActivityKey(userId),
      api.membersKey(userId, owner),
      blocks.blockKey(userId),
    ].map((key) => observe(key));
    const immediate = [
      api.mediaRoomKey(userId, owner, "lounge"),
      administration.administrationKey(userId, owner.id),
    ].map((key) => observe(key));
    try {
      hidden(true);
      await run({ type: "ready", leaseExpiresAt: 100_000, resync: true });
      expect(effects.resync).toHaveBeenCalledOnce();
      expect(effects.callChanged).toHaveBeenCalledWith();
      for (const watched of metadata)
        expect(watched.fetcher).not.toHaveBeenCalled();
      for (const watched of immediate)
        expect(watched.fetcher).toHaveBeenCalledOnce();
      hidden(false);
      memory.resume();
      await vi.advanceTimersByTimeAsync(0);
      for (const watched of metadata)
        expect(watched.fetcher).toHaveBeenCalledOnce();
    } finally {
      for (const watched of [...metadata, ...immediate]) watched.stop();
    }
  });
});
afterEach(() => {
  memory.dispose();
  client.clear();
  vi.useRealTimers();
});

describe("inbox hints on the activity cache", () => {
  it("coalesces several owners into one account read and a trailing read after a slow response", async () => {
    seedActivity();
    const key = activity.accountActivityKey(userId);
    const initialData =
      client.getQueryData<import("@/client/api/activity").ActivityData>(key)!;
    const held = deferred<typeof initialData>();
    const settled = {
      ...initialData,
      pages: initialData.pages.map((page) => ({
        ...page,
        owners: [ownerState(3, 8, 5)],
      })),
    };
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(({ signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return signals.length === 1 ? held.promise : Promise.resolve(settled);
    });
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: fetcher,
      staleTime: Infinity,
    });
    const stop = observer.subscribe(() => {});
    try {
      for (let index = 0; index < 10; index++)
        apply.applyAccountEvent(
          client,
          userId,
          {
            type: "mutation",
            owner: { ...owner, id: `owner-${index}` },
            channelId,
            generation,
            sequence: index + 1,
          },
          memory,
          effects,
        );
      expect(fetcher).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(signals[0]?.aborted).toBe(false);
      held.resolve(initialData);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(client.getQueryData(key)).toEqual(settled);
    } finally {
      stop();
    }
  });

  it.each([false, true])(
    "waits for a pre-hint request and preserves a trailing read unless disposed (%s)",
    async (disposed) => {
      seedActivity();
      const key = activity.accountActivityKey(userId);
      const initialData =
        client.getQueryData<import("@/client/api/activity").ActivityData>(key)!;
      const held = deferred<typeof initialData>();
      const fetcher = vi
        .fn()
        .mockReturnValueOnce(held.promise)
        .mockResolvedValue(initialData);
      const observer = new QueryObserver(client, {
        queryKey: key,
        queryFn: fetcher,
        staleTime: Infinity,
      });
      const stop = observer.subscribe(() => {});
      try {
        void observer.refetch();
        await run({
          type: "mutation",
          owner,
          channelId,
          generation,
          sequence: 6,
        });
        expect(fetcher).toHaveBeenCalledOnce();
        if (disposed) memory.dispose();
        held.resolve(initialData);
        await vi.advanceTimersByTimeAsync(0);
        expect(fetcher).toHaveBeenCalledTimes(disposed ? 1 : 2);
      } finally {
        stop();
      }
    },
  );

  it("re-reads notification settings after a change elsewhere or a reconnect, even while hidden", async () => {
    const key = notifications.notificationsKey(userId);
    client.setQueryData(key, { revision: 1 });
    vi.stubGlobal("document", { visibilityState: "hidden" });
    expect(await run({ type: "notification_settings" })).toBe("invalidated");
    expect(invalidated(key)).toBe(true);
    client.setQueryData(key, { revision: 2 });
    await run({ type: "ready", leaseExpiresAt: 100_000, resync: true });
    expect(invalidated(key)).toBe(true);
  });

  it("refreshes activity without predicting counts and ignores duplicate hints", async () => {
    seedActivity(ownerState(0, 5, 5));
    const hint = {
      type: "activity" as const,
      owner,
      channelId,
      generation,
      sequence: 6,
      direct: true,
    };
    expect(await run(hint)).toBe("invalidated");
    expect(invalidated(activity.accountActivityKey(userId))).toBe(true);
    expect(effects.messageArrived).toHaveBeenCalledExactlyOnceWith(hint);
    expect(channel()).toMatchObject({
      lastCreatedSequence: 5,
      unreadCount: 0,
      mentionCount: 0,
    });
    expect(await run(hint)).toBe("ignored");
    expect(effects.messageArrived).toHaveBeenCalledTimes(1);
    expect(await run({ ...hint, sequence: 7 }, 10_500)).toBe("scheduled");
    expect(channel().unreadCount).toBe(0);
    // The refreshed summary supplies both counts; an exact read clears both immediately.
    const summary = ownerState(2, 7, 5);
    summary.channels[0]!.mentionCount = 1;
    seedActivity(summary);
    expect(
      await run(
        { type: "read", owner, channelId, generation, sequence: 7 },
        13_000,
      ),
    ).toBe("applied");
    expect(channel()).toMatchObject({
      readSequence: 7,
      unreadCount: 0,
      mentionCount: 0,
      hasUnread: false,
    });
    // A delayed activity hint cannot revive counts already cleared by the read.
    expect(await run({ ...hint, sequence: 5 }, 16_000)).toBe("invalidated");
    expect(channel().unreadCount).toBe(0);
  });
  it("coalesces refreshes inside the window and never drops the trailing one", async () => {
    vi.useFakeTimers();
    seedActivity();
    const spy = vi.spyOn(client, "invalidateQueries");
    const mutation = (sequence: number) => ({
      type: "mutation" as const,
      owner,
      channelId,
      generation,
      sequence,
    });
    expect(await run(mutation(6), 10_000)).toBe("invalidated");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await run(mutation(7), 10_500)).toBe("scheduled");
    expect(await run(mutation(8), 11_000)).toBe("scheduled");
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(apply.INVALIDATION_THROTTLE_MS);
    expect(spy).toHaveBeenCalledTimes(2);
  });
  it("clears the count when a read reaches the end and asks the server for a partial read or a mutation", async () => {
    seedActivity(ownerState(2, 5, 3));
    const read = {
      type: "read" as const,
      owner,
      channelId,
      generation,
      sequence: 4,
    };
    expect(await run(read)).toBe("invalidated");
    expect(channel()).toMatchObject({ readSequence: 4, unreadCount: 2 });
    expect(await run({ ...read, sequence: 5 }, 20_000)).toBe("applied");
    expect(channel()).toMatchObject({
      readSequence: 5,
      unreadCount: 0,
      hasUnread: false,
    });
    expect(await run({ ...read, sequence: 5 }, 30_000)).toBe("ignored");
    expect(await run({ ...read, sequence: 2 }, 40_000)).toBe("ignored");
    expect(
      await run(
        { type: "mutation", owner, channelId, generation, sequence: 5 },
        50_000,
      ),
    ).toBe("invalidated");
  });
});

describe("inbox hints on the directory and other caches", () => {
  it("refreshes directory and room snapshots without patching occupancy or retiring history", async () => {
    seedDirectory();
    const key = api.directoryKey(userId);
    const previous = client.getQueryData(key);
    client.setQueryData(api.mediaRoomKey(userId, owner, "lounge"), {});
    const hint = { type: "occupancy" as const, owner, channelId: "lounge" };
    expect(await run(hint)).toBe("invalidated");
    expect(client.getQueryData(key)).toBe(previous);
    expect(invalidated(key)).toBe(true);
    expect(invalidated(api.mediaRoomKey(userId, owner, "lounge"))).toBe(true);
    expect(await run(hint, 10_500)).toBe("scheduled");
    await vi.advanceTimersByTimeAsync(apply.INVALIDATION_THROTTLE_MS);
    expect(client.getQueryData(key)).toBe(previous);
    expect(effects.contentChanged).not.toHaveBeenCalled();
  });
  it("turns presence, directory, block and ready hints into refreshes of the authorized reads", async () => {
    seedDirectory();
    seedActivity();
    client.setQueryData(api.membersKey(userId, owner), {});
    client.setQueryData([...blocks.blockKey(userId), "person", other], "none");
    expect(await run({ type: "presence", owner, userId: other })).toBe(
      "invalidated",
    );
    expect(invalidated(api.membersKey(userId, owner))).toBe(false);
    expect(effects.presenceChanged).toHaveBeenCalledWith(owner, other);
    client.setQueryData(api.membersKey(userId, owner), {});
    expect(await run({ type: "directory", owner })).toBe("invalidated");
    expect(invalidated(api.directoryKey(userId))).toBe(true);
    expect(invalidated(api.membersKey(userId, owner))).toBe(true);
    expect(invalidated(activity.accountActivityKey(userId))).toBe(true);
    expect(effects.contentChanged).toHaveBeenCalledWith(owner, true);
    expect(
      await run({
        type: "dm_policy",
        owner: { kind: "conversation", id: "dm" },
      }),
    ).toBe("invalidated");
    expect(invalidated([...blocks.blockKey(userId), "person", other])).toBe(
      true,
    );
    seedDirectory();
    seedActivity();
    const block = [...blocks.blockKey(userId), "person", other];
    const media = api.mediaRoomKey(userId, owner, "lounge");
    client.setQueryData(block, "none");
    client.setQueryData(media, {});
    expect(await run({ type: "ready", leaseExpiresAt: 1, resync: true })).toBe(
      "invalidated",
    );
    expect(invalidated(api.directoryKey(userId))).toBe(true);
    expect(invalidated(activity.accountActivityKey(userId))).toBe(true);
    expect(invalidated(block)).toBe(true);
    expect(invalidated(media)).toBe(true);
    expect(effects.resync).toHaveBeenCalledOnce();
    expect(effects.callChanged).toHaveBeenCalledWith();
    expect(await run({ type: "pong" })).toBe("ignored");
  });
  it("refreshes the active call without refreshing Home for publication changes", async () => {
    seedDirectory();
    const key = api.mediaRoomKey(userId, owner, "lounge");
    client.setQueryData(key, {});
    const notice = { type: "call" as const, owner, channelId: "lounge" };
    const held = deferred<void>();
    vi.mocked(effects.callChanged).mockReturnValueOnce(held.promise);
    await run(notice);
    await run(notice, 10_500);
    expect(effects.callChanged).toHaveBeenCalledTimes(1);
    expect(invalidated(key)).toBe(true);
    expect(invalidated(api.directoryKey(userId))).toBe(false);
    held.resolve();
    await vi.advanceTimersByTimeAsync(apply.INVALIDATION_THROTTLE_MS);
    expect(effects.callChanged).toHaveBeenCalledTimes(2);
    expect(effects.callChanged).toHaveBeenLastCalledWith({
      owner,
      channelId: "lounge",
    });
    expect(effects.contentChanged).not.toHaveBeenCalled();
  });
});
