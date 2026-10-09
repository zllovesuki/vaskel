import { deferred } from "@tests/shared/deferred";
import { fetchRequest } from "@tests/helpers/http";
import { InfiniteQueryObserver, QueryClient } from "@tanstack/react-query";
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
import {
  latestTimeline,
  type Timeline,
} from "@/client/features/chat/reconcile";

let activity: typeof import("@/client/api/activity");
let reconciliation: typeof import("@/client/features/activity/reconcile");
let model: typeof import("@/client/features/activity/model");
let api: typeof import("@/client/api/client");
let client: QueryClient;
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const userId = id(1);
const otherAccount = id(2);
const owner = { kind: "server" as const, id: id(3) };
const generation = id(4);
const channelId = id(5);
function ownerState(read = 0, last = 5): OwnerActivity {
  return {
    owner,
    generation,
    channels: [
      {
        channelId,
        lastCreatedSequence: last,
        readSequence: read,
        unreadCount: Math.min(100, Math.max(0, last - read)),
        mentionCount: 0,
        hasUnread: last > read,
      },
    ],
    nextCursor: null,
  };
}
function page(owners = [ownerState()]) {
  return {
    kind: "activity" as const,
    owners,
    unavailableOwners: [],
    partial: false,
    nextCursor: null as string | null,
  };
}
function timeline(read = 0, created = 5, updated = created): Timeline {
  return latestTimeline({
    cursor: { owner, channelId, generation, sequence: updated },
    nextBefore: null,
    readSequence: read,
    messages: [
      {
        id: id(6),
        channelId,
        authorId: otherAccount,
        body: "Private text",
        attachments: [],
        createdAt: 1,
        updatedAt: 1,
        deletedAt: null,
        reactions: [],
        mentions: [],
        createdSequence: created,
        updatedSequence: updated,
        version: updated,
      },
    ],
  });
}
const resources: ResourceSummary[] = [
  {
    owner,
    name: "Friends",
    role: "member",
    membersMayInvite: true,
    canCreateInvite: true,
    version: 1,
    channels: [
      {
        id: channelId,
        name: "general",
        kind: "text",
        private: false,
        version: 1,
        topic: null,
        occupancy: null,
        position: 0,
      },
    ],
  },
];

beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  activity = await import("@/client/api/activity");
  reconciliation = await import("@/client/features/activity/reconcile");
  model = await import("@/client/features/activity/model");
  api = await import("@/client/api/client");
});
beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
});
afterEach(() => {
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("private activity queries", () => {
  it.each(["mention", "read"] as const)(
    "rejects stale counts when a delayed HTTP response follows a newer %s",
    async (change) => {
      const initial = ownerState(5, change === "read" ? 6 : 5);
      initial.channels[0]!.mentionCount = change === "read" ? 1 : 0;
      const held = deferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(Response.json(page([initial])))
          .mockReturnValueOnce(held.promise),
      );
      const options = activity.accountActivityOptions(userId);
      await client.fetchInfiniteQuery(options);
      const pending = client.fetchInfiniteQuery({ ...options, staleTime: 0 });
      const observed = timeline(change === "read" ? 6 : 5, 6);
      observed.messages[0]!.mentions = [userId];
      reconciliation.syncTimelineActivity(
        client,
        userId,
        owner,
        channelId,
        observed,
      );
      held.resolve(Response.json(page([initial])));
      await pending;
      const cached = () =>
        client.getQueryData(options.queryKey)!.pages[0]!.owners[0]!
          .channels[0]!;
      expect(cached()).toMatchObject({
        lastCreatedSequence: 6,
        readSequence: change === "read" ? 6 : 5,
        unreadCount: 0,
        mentionCount: 0,
      });
      if (change === "read") {
        reconciliation.syncTimelineActivity(
          client,
          userId,
          owner,
          channelId,
          timeline(6, 7),
        );
        expect(cached()).toMatchObject({ unreadCount: 0, mentionCount: 0 });
      }
    },
  );

  it("rejects counts below the known read floor even when a response includes a newer creation", () => {
    const caughtUp = ownerState(6, 6);
    const staleRead = ownerState(5, 7);
    staleRead.channels[0]!.mentionCount = 1;
    const merged = activity.mergeOwnerActivity(caughtUp, staleRead);
    expect(merged.channels[0]).toMatchObject({
      lastCreatedSequence: 7,
      readSequence: 6,
      unreadCount: 0,
      mentionCount: 0,
    });
    const current = ownerState(6, 7);
    current.channels[0]!.mentionCount = 1;
    expect(
      activity.mergeOwnerActivity(merged, current).channels[0],
    ).toMatchObject({ unreadCount: 1, mentionCount: 1 });
  });

  it("prefetches summaries without reading messages and caps retained account polling pages", async () => {
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = fetchRequest(input, init);
        expect(request.method).toBe("GET");
        const after = new URL(request.url).searchParams.get("after");
        const index = after ? Number(after.slice(-2)) : 0;
        return Response.json({
          ...page(),
          nextCursor: id(index + 1),
          partial: true,
        });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const key = api.timelineKey(userId, owner, channelId);
    client.setQueryData(key, timeline());
    const options = activity.accountActivityOptions(userId);
    await client.prefetchInfiniteQuery(options);
    expect(client.getQueryData<Timeline>(key)?.readSequence).toBe(0);
    const observer = new InfiniteQueryObserver(client, options);
    const stop = observer.subscribe(() => {});
    for (let index = 0; index < 4; index++) await observer.fetchNextPage();
    expect(observer.getCurrentResult().data?.pages).toHaveLength(3);
    expect(observer.getCurrentResult().data?.pageParams[0]).toBe(id(2));
    fetch.mockClear();
    await observer.refetch();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      fetch.mock.calls.every(
        ([input, init]) =>
          new URL(fetchRequest(input, init).url).pathname ===
          "/api/account/activity",
      ),
    ).toBe(true);
    expect(client.getQueryData<Timeline>(key)?.readSequence).toBe(0);
    stop();
  });

  it("keeps private read progress from a same-account update when an older summary arrives late", async () => {
    const gate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(page()))
        .mockImplementationOnce(() => gate.promise),
    );
    const options = activity.accountActivityOptions(userId);
    await client.fetchInfiniteQuery(options);
    const pending = client.fetchInfiniteQuery({ ...options, staleTime: 0 });
    reconciliation.syncTimelineActivity(
      client,
      userId,
      owner,
      channelId,
      timeline(5),
    );
    gate.resolve(Response.json(page()));
    await pending;
    const cached = client.getQueryData(options.queryKey)!;
    expect(cached.pages[0]!.owners[0]!.channels[0]).toMatchObject({
      readSequence: 5,
      hasUnread: false,
    });
    const key = api.timelineKey(userId, owner, channelId);
    client.setQueryData(key, timeline());
    const otherKey = api.timelineKey(otherAccount, owner, channelId);
    client.setQueryData(otherKey, timeline());
    reconciliation.syncActivityReads(client, userId, cached.pages[0]!.owners);
    expect(client.getQueryData<Timeline>(key)?.readSequence).toBe(5);
    expect(client.getQueryData<Timeline>(otherKey)?.readSequence).toBe(0);
  });

  it("reconciles a read that completed before the first summary without sending another read or changing stable data", async () => {
    const fetch = vi.fn(async () => Response.json(page()));
    vi.stubGlobal("fetch", fetch);
    const key = api.timelineKey(userId, owner, channelId);
    client.setQueryData(key, timeline(5));
    const options = activity.accountActivityOptions(userId);
    await client.fetchInfiniteQuery(options);
    reconciliation.syncActivityReads(
      client,
      userId,
      client.getQueryData(options.queryKey)!.pages[0]!.owners,
    );
    const current = client.getQueryData(options.queryKey)!;
    expect(current.pages[0]!.owners[0]!.channels[0]!.hasUnread).toBe(false);
    reconciliation.syncActivityReads(client, userId, current.pages[0]!.owners);
    expect(client.getQueryData(options.queryKey)).toBe(current);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses creation positions across edits and tombstones, and never carries positions into a restored generation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(page([ownerState(5)]))),
    );
    const options = activity.accountActivityOptions(userId);
    await client.fetchInfiniteQuery(options);
    const beforeEdit = client.getQueryData(options.queryKey);
    const edited = timeline(5, 5, 40);
    reconciliation.syncTimelineActivity(
      client,
      userId,
      owner,
      channelId,
      edited,
    );
    reconciliation.syncTimelineActivity(client, userId, owner, channelId, {
      ...edited,
      messages: edited.messages.map((message) => ({
        ...message,
        body: "",
        deletedAt: 42,
        reactions: [],
        mentions: [],
        updatedSequence: 41,
      })),
    });
    expect(
      client.getQueryData(options.queryKey)!.pages[0]!.owners[0]!.channels[0],
    ).toMatchObject({ lastCreatedSequence: 5, hasUnread: false });
    expect(client.getQueryData(options.queryKey)).toBe(beforeEdit);
    await client.fetchInfiniteQuery({ ...options, staleTime: 0 });
    expect(client.getQueryData(options.queryKey)).toBe(beforeEdit);
    reconciliation.syncTimelineActivity(
      client,
      userId,
      owner,
      channelId,
      timeline(5, 42),
    );
    expect(
      client.getQueryData(options.queryKey)!.pages[0]!.owners[0]!.channels[0],
    ).toMatchObject({ lastCreatedSequence: 42, hasUnread: false });
    const restored = { ...ownerState(0, 1), generation: id(9) };
    expect(activity.mergeOwnerActivity(ownerState(42, 42), restored)).toEqual(
      restored,
    );
    const key = api.timelineKey(userId, owner, channelId);
    client.setQueryData(key, timeline());
    reconciliation.syncActivityReads(client, userId, [
      { ...ownerState(99, 99), generation: id(9) },
    ]);
    expect(client.getQueryData<Timeline>(key)?.readSequence).toBe(0);
  });

  it("retains authoritative positive counts through partial reads and arrivals, then clears at the end", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(page([ownerState(0, 5)]))),
    );
    const options = activity.accountActivityOptions(userId);
    await client.fetchInfiniteQuery(options);
    const resident = timeline(0, 5);
    const older = {
      ...resident.messages[0]!,
      id: id(7),
      mentions: [userId],
      createdSequence: 4,
      updatedSequence: 4,
      version: 1,
    };
    // Resident rows do not replace the owner count during a partial read.
    reconciliation.syncTimelineActivity(client, userId, owner, channelId, {
      ...resident,
      messages: [older, resident.messages[0]!],
      readSequence: 3,
    });
    const state = () =>
      client.getQueryData(options.queryKey)!.pages[0]!.owners[0]!.channels[0];
    expect(state()).toMatchObject({
      readSequence: 3,
      unreadCount: 5,
      mentionCount: 0,
    });
    // A newer resident row waits for the next summary; the cursor at the end clears.
    const newer = {
      ...older,
      id: id(8),
      createdSequence: 6,
      updatedSequence: 6,
    };
    reconciliation.syncTimelineActivity(client, userId, owner, channelId, {
      ...resident,
      messages: [older, resident.messages[0]!, newer],
      lastCreatedSequence: 6,
      readSequence: 3,
    });
    expect(state()).toMatchObject({ lastCreatedSequence: 6, unreadCount: 5 });
    reconciliation.syncTimelineActivity(client, userId, owner, channelId, {
      ...resident,
      lastCreatedSequence: 6,
      readSequence: 6,
    });
    expect(state()).toMatchObject({ unreadCount: 0, hasUnread: false });
  });

  it("never counts an arrival it cannot classify, such as an own or deleted message beyond the resident window, and asks the server instead", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(page([ownerState(5)]))),
    );
    const options = activity.accountActivityOptions(userId);
    await client.fetchInfiniteQuery(options);
    // Sequence 30 was observed (a receipt for an own send, or a socket frame
    // for a deleted message) while an older window is held; no row is resident.
    reconciliation.syncTimelineActivity(client, userId, owner, channelId, {
      ...timeline(5, 5, 40),
      mode: "paused",
      lastCreatedSequence: 30,
    });
    expect(
      client.getQueryData(options.queryKey)!.pages[0]!.owners[0]!.channels[0],
    ).toMatchObject({
      lastCreatedSequence: 30,
      readSequence: 5,
      unreadCount: 0,
      mentionCount: 0,
      hasUnread: false,
    });
    expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(true);
  });

  it("removes revoked channels, retains honest partial coverage, and hides failed or offline cached indicators", async () => {
    const unavailableOwner = { kind: "conversation" as const, id: id(8) };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(page()))
        .mockResolvedValueOnce(
          Response.json({
            ...page([{ ...ownerState(), channels: [] }]),
            partial: true,
            unavailableOwners: [unavailableOwner],
          }),
        ),
    );
    const options = activity.accountActivityOptions(userId);
    await client.fetchInfiniteQuery(options);
    await client.fetchInfiniteQuery({ ...options, staleTime: 0 });
    const current = client.getQueryData(options.queryKey)!.pages[0]!;
    expect(current.owners[0]!.channels).toEqual([]);
    expect(current.unavailableOwners).toEqual([unavailableOwner]);
    expect(
      model.activityModel(
        resources,
        current.owners,
        current.unavailableOwners,
        true,
      ),
    ).toMatchObject({ incomplete: true, unread: [] });
    expect(
      model.activityModel(resources, [ownerState()], [], false),
    ).toMatchObject({ incomplete: true, unread: [] });
    expect(
      model.activityModel(resources, [ownerState()], [owner], true),
    ).toMatchObject({ incomplete: true, unread: [] });
    const overlapping = model.activityModel(
      resources,
      [ownerState(5), ownerState(0)],
      [],
      true,
    );
    expect(overlapping.unread).toEqual([]);
  });

  it("aborts account summaries and rejects late cache writes after account teardown", async () => {
    const gate = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_path: string, init: RequestInit) => {
        signal = init.signal;
        return gate.promise;
      }),
    );
    const options = activity.accountActivityOptions(userId);
    const pending = client.fetchInfiniteQuery(options);
    const rejected = expect(pending).rejects.toThrow();
    await client.cancelQueries({ queryKey: api.privateKey(userId) });
    client.removeQueries({ queryKey: api.privateKey(userId) });
    expect(signal?.aborted).toBe(true);
    gate.resolve(Response.json(page()));
    await rejected;
    await Promise.resolve();
    expect(client.getQueryData(options.queryKey)).toBeUndefined();
    expect(
      client.getQueryData(activity.accountActivityKey(otherAccount)),
    ).toBeUndefined();
  });

  it("bounds explicit channel continuation and clears denied-owner indicators without erasing message history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        new URL(fetchRequest(input, init).url).pathname.includes("/resources/")
          ? Response.json({
              kind: "owner_activity",
              ...ownerState(),
              nextCursor: id(8),
            })
          : Response.json(page()),
      ),
    );
    const options = activity.accountActivityOptions(userId);
    await client.fetchInfiniteQuery(options);
    const extra = activity.ownerActivityOptions(userId, owner, id(7));
    const observer = new InfiniteQueryObserver(client, extra);
    const stop = observer.subscribe(() => {});
    await observer.refetch();
    await observer.fetchNextPage();
    await observer.fetchNextPage();
    expect(observer.getCurrentResult().data?.pages).toHaveLength(2);
    stop();
    const key = api.timelineKey(userId, owner, channelId);
    client.setQueryData(key, timeline());
    reconciliation.invalidateActivityAccess(client, userId, owner);
    const current = client.getQueryData(options.queryKey)!.pages[0]!;
    expect(current.owners).toEqual([]);
    expect(current.unavailableOwners).toEqual([owner]);
    expect(client.getQueryData(extra.queryKey)).toBeUndefined();
    expect(client.getQueryData<Timeline>(key)?.messages).toHaveLength(1);
  });
});
