import { failureResponse } from "@tests/helpers/http";
import { deferred } from "@tests/shared/deferred";
import {
  connected,
  owner,
  cursor,
  key,
  row,
  state,
  client,
  restoreAccess,
  disposals,
  replay,
  connection,
  liveSocket,
  ticketFetch,
  committed,
  setupTimeline,
} from "@tests/helpers/timeline-connection";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AccountFence,
  HistoryCache,
  HistoryProjection,
  ScopeCapture,
} from "@/client/features/cache/model";
import { TimelineProjection } from "@/client/features/cache/timeline-projection";
import { type Timeline } from "@/client/features/chat/reconcile";

beforeEach(setupTimeline);
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
  client.clear();
  restoreAccess();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const next = { ...row, id: "next", createdSequence: 11, updatedSequence: 11 };

describe("timeline denial sources", () => {
  it("closes on an HTTP replay denial, hands transport's error to its callback and never purges Query itself", async () => {
    const { installRequestAccess } = await import("@/client/api/client");
    const failed = vi.fn();
    const restore = installRequestAccess({
      begin: () => ({ current: () => true, accountId: "account" }),
      failed,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        failureResponse({ kind: "forbidden" }, { status: 403 }),
      ),
    );
    const onDenied = vi.fn();
    const status = vi.fn();
    const active = connection({ onDenied, status });
    try {
      await active.reconcile();
      expect(failed).toHaveBeenCalledOnce();
      expect(onDenied).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ code: "forbidden", failure: "http" }),
      );
      expect(status).toHaveBeenLastCalledWith("denied");
      expect(client.getQueryData(key)).toEqual(state);
      await active.reconcile();
      expect(failed).toHaveBeenCalledOnce();
      expect(onDenied).toHaveBeenCalledOnce();
    } finally {
      restore();
    }
  });

  it("reports socket access changes and closes the connection", async () => {
    const sockets = liveSocket();
    vi.stubGlobal(
      "fetch",
      ticketFetch(() => replay(10)),
    );
    const onDenied = vi.fn();
    const status = vi.fn();
    connection({ onDenied, status });
    await vi.waitFor(() =>
      expect(status).toHaveBeenLastCalledWith("connected"),
    );
    sockets[0]!.receive({
      data: '{"type":"access_changed"}',
    } as MessageEvent<string>);
    expect(onDenied).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "forbidden", failure: "socket" }),
    );
    expect(status).toHaveBeenLastCalledWith("denied");
    // The coordinator purges a denied owner; the connection only closes.
    expect(client.getQueryData(key)).toEqual(state);
    await vi.waitFor(() => expect(sockets[0]!.readyState).toBe(3));
  });
});

describe("committed frame advancement", () => {
  it("displays contiguous sends while disk is held and rejects their exports after retirement", async () => {
    const account: AccountFence = {
      origin: "https://vaskel.test",
      accountId: "account",
      accountEpoch: crypto.randomUUID(),
      cacheId: crypto.randomUUID(),
    };
    const scope: ScopeCapture = {
      ...account,
      owner,
      generation: cursor.generation,
      retirementRevision: 0,
      scopeEpoch: crypto.randomUUID(),
    };
    const disk: { current: HistoryProjection | null } = { current: null };
    const storage = {
      captureScope: vi.fn(async () => ({ kind: "ok", value: scope })),
      authorizeScope: vi.fn(async () => ({ kind: "ok", value: scope })),
      save: vi.fn(async (_fence: unknown, value: HistoryProjection) => {
        disk.current = value;
        return { kind: "miss" };
      }),
      invalidateOwner: vi.fn(async () => {
        disk.current = null;
        return { kind: "ok" };
      }),
    } as unknown as HistoryCache;
    const projection = new TimelineProjection(
      account,
      owner,
      () => ({ owner: "Circle", channel: "General", authors: [] }),
      storage,
    );
    disposals.push(() => projection.dispose());
    const sockets = liveSocket();
    vi.stubGlobal(
      "fetch",
      ticketFetch(() => replay(10)),
    );
    const status = vi.fn();
    connection({ projection, status });
    await vi.waitFor(() =>
      expect(status).toHaveBeenLastCalledWith("connected"),
    );
    await projection.capture();
    const held = deferred<void>();
    vi.mocked(storage.save).mockImplementationOnce(async (_fence, value) => {
      await held.promise;
      disk.current = value;
      return { kind: "miss" };
    });
    const captures = vi.mocked(storage.captureScope).mock.calls.length;
    sockets[0]!.receive({
      data: committed(11, 10, 0, next),
    } as MessageEvent<string>);
    await vi.waitFor(() => expect(storage.save).toHaveBeenCalledTimes(2));
    const later = {
      ...next,
      id: "later",
      createdSequence: 12,
      updatedSequence: 12,
    };
    sockets[0]!.receive({
      data: committed(12, 11, 0, later),
    } as MessageEvent<string>);
    expect(client.getQueryData<Timeline>(key)?.messages).toEqual([
      row,
      next,
      later,
    ]);
    expect(client.getQueryData<Timeline>(key)?.cursor.sequence).toBe(12);
    expect(storage.captureScope).toHaveBeenCalledTimes(captures);
    const oldLease = projection.currentLease();
    const retirement = projection.withhold();
    expect(projection.currentLease()).toBeNull();
    held.resolve();
    await retirement;
    expect(disk.current).toBeNull();
    const writes = vi.mocked(storage.save).mock.calls.length;
    projection.accepted(oldLease, client.getQueryData<Timeline>(key)!, false);
    await projection.capture();
    expect(storage.save).toHaveBeenCalledTimes(writes);
  });

  it("inserts frames whose predecessor is the contiguous cursor, in arrival order and without asking for replay", async () => {
    const later = {
      ...row,
      id: "later",
      createdSequence: 12,
      updatedSequence: 12,
    };
    const fetcher = ticketFetch(() => replay(10));
    const { sockets } = await connected(fetcher);
    const requests = fetcher.mock.calls.length;
    // The second frame is only contiguous once the first one has landed.
    sockets[0]!.receive({
      data: committed(11, 10, 0, next),
    } as MessageEvent<string>);
    sockets[0]!.receive({
      data: committed(12, 11, 0, later),
    } as MessageEvent<string>);
    await vi.waitFor(() =>
      expect(client.getQueryData<Timeline>(key)?.cursor.sequence).toBe(12),
    );
    expect(client.getQueryData<Timeline>(key)?.messages).toEqual([
      row,
      next,
      later,
    ]);
    expect(fetcher).toHaveBeenCalledTimes(requests);
  });

  it("retires the channel's search pages under the panel's own key and leaves other channels alone", async () => {
    const api = await import("@/client/api/client");
    const edited = { ...next, version: 2 };
    const searched = api.messageSearchKey(
      "account",
      owner,
      "general",
      "Recent",
    );
    const elsewhere = api.messageSearchKey(
      "account",
      owner,
      "random",
      "Recent",
    );
    const matches = { kind: "matches", messages: [row, next] };
    client.setQueryData(searched, matches);
    client.setQueryData(elsewhere, matches);
    const { sockets } = await connected(ticketFetch(() => replay(10)));
    sockets[0]!.receive({
      data: committed(11, 10, 0, edited),
    } as MessageEvent<string>);
    await vi.waitFor(() =>
      expect(client.getQueryData<Timeline>(key)?.cursor.sequence).toBe(11),
    );
    expect(client.getQueryData(searched)).toEqual({
      kind: "matches",
      messages: [row],
    });
    expect(client.getQueryState(searched)?.isInvalidated).toBe(true);
    expect(client.getQueryData(elsewhere)).toEqual(matches);
    expect(client.getQueryState(elsewhere)?.isInvalidated).toBe(false);
  });

  it("holds a frame that skips a send until replay supplies the missing event", async () => {
    const skipped = {
      ...row,
      id: "skipped",
      createdSequence: 12,
      updatedSequence: 12,
    };
    const held = deferred<Response>();
    const replies: (Response | Promise<Response>)[] = [
      replay(10),
      held.promise,
    ];
    const fetcher = ticketFetch(() => replies.shift() ?? replay(12));
    const { sockets } = await connected(fetcher);
    const requests = fetcher.mock.calls.length;
    sockets[0]!.receive({
      data: committed(12, 11, 0, skipped),
    } as MessageEvent<string>);
    expect(client.getQueryData<Timeline>(key)?.messages).toEqual([row]);
    expect(client.getQueryData<Timeline>(key)?.lastCreatedSequence).toBe(12);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(requests + 1));
    held.resolve(
      Response.json({
        kind: "replay",
        events: [
          { operation: "send", sequence: 11, message: next },
          { operation: "send", sequence: 12, message: skipped },
        ],
        cursor: { ...cursor, sequence: 12 },
        highWater: 12,
        hasMore: false,
      }),
    );
    await vi.waitFor(() =>
      expect(client.getQueryData<Timeline>(key)?.messages).toEqual([
        row,
        next,
        skipped,
      ]),
    );
    expect(client.getQueryData<Timeline>(key)?.cursor.sequence).toBe(12);
  });

  it("replaces the window from a snapshot when a matching predecessor arrives with a replay floor above the cursor", async () => {
    const replacement = { ...cursor, sequence: 21 };
    const pruned = {
      ...row,
      id: "pruned",
      createdSequence: 21,
      updatedSequence: 21,
    };
    const replies = [
      replay(10),
      failureResponse(
        { kind: "reset_required", reason: "floor" },
        { status: 409 },
      ),
      Response.json({
        kind: "snapshot",
        messages: [pruned],
        cursor: replacement,
        nextBefore: null,
        readSequence: 5,
      }),
      Response.json({
        kind: "replay",
        events: [],
        cursor: replacement,
        highWater: 21,
        hasMore: false,
      }),
    ];
    const fetcher = ticketFetch(() => replies.shift() ?? replay(21));
    const { sockets } = await connected(fetcher);
    // The predecessor link alone looks contiguous; the floor overrules it.
    sockets[0]!.receive({
      data: committed(21, 10, 20, pruned),
    } as MessageEvent<string>);
    await vi.waitFor(() =>
      expect(client.getQueryData<Timeline>(key)?.cursor.sequence).toBe(21),
    );
    expect(
      fetcher.mock.calls.map(([path]) =>
        typeof path === "string" ? path : new URL(path.url).pathname,
      ),
    ).toEqual([
      "/api/resources/server/owner/socket-ticket",
      "/api/resources/server/owner/replay",
      "/api/resources/server/owner/replay",
      "/api/resources/server/owner/snapshot",
      "/api/resources/server/owner/replay",
    ]);
    expect(client.getQueryData<Timeline>(key)?.messages).toEqual([pruned]);
  });

  it("reports received typing, ignores pong and throttles its own typing sends", async () => {
    const sockets = liveSocket();
    vi.stubGlobal(
      "fetch",
      ticketFetch(() => replay(10)),
    );
    const status = vi.fn();
    const onTyping = vi.fn();
    const active = connection({ status, onTyping });
    await vi.waitFor(() =>
      expect(status).toHaveBeenLastCalledWith("connected"),
    );
    const frame = {
      type: "typing",
      channelId: "general",
      userId: "author",
      expiresAt: Date.now() + 6_000,
    };
    sockets[0]!.receive({
      data: JSON.stringify(frame),
    } as MessageEvent<string>);
    sockets[0]!.receive({
      data: '{"type":"pong"}',
    } as MessageEvent<string>);
    expect(onTyping).toHaveBeenCalledExactlyOnceWith(frame);
    expect(sockets[0]!.readyState).toBe(1);
    active.sendTyping();
    active.sendTyping();
    expect(sockets[0]!.sent).toEqual(['{"type":"typing"}']);
  });

  it("does not promote successful HTTP replay to connected before the socket reaches ready", async () => {
    vi.useFakeTimers({
      toFake: [
        "Date",
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
      ],
    });
    const sockets = liveSocket(false);
    const fetcher = ticketFetch(() => replay(10));
    vi.stubGlobal("fetch", fetcher);
    const status = vi.fn();
    const active = connection({ status });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await active.reconcile();
    expect(status).not.toHaveBeenCalledWith("connected");
    await vi.advanceTimersByTimeAsync(11_200);
    expect(sockets[0]!.readyState).toBe(3);
    expect(sockets).toHaveLength(2);
    expect(status).toHaveBeenLastCalledWith("reconnecting");
  });
});
