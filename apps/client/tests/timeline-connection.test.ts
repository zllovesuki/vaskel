import { fetchRequest } from "@tests/helpers/http";
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
  contentListeners,
  hintContent,
  replay,
  connection,
  Socket,
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
import {
  followTimeline,
  latestTimeline,
  type Timeline,
} from "@/client/features/chat/reconcile";

beforeEach(setupTimeline);
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.useRealTimers();
  client.clear();
  restoreAccess();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("timeline replay fallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  it("renews the same socket without adding replay reads or postponing fallback", async () => {
    const sockets = liveSocket();
    const fetcher = ticketFetch(() => replay(10));
    vi.stubGlobal("fetch", fetcher);
    const status = vi.fn();
    connection({ status });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(sockets[0]!.sent).toEqual(['{"type":"ping"}']);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.readyState).toBe(Socket.OPEN);
    expect(sockets[0]!.sent).toHaveLength(1);
    expect(status).toHaveBeenLastCalledWith("connected");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(sockets).toHaveLength(1);
    expect(
      fetcher.mock.calls.filter(([path]) =>
        (typeof path === "string" ? path : path.url).endsWith("/socket-renew"),
      ),
    ).toHaveLength(4);
    // Initial catch-up and independent repair at 60 and 120 seconds.
    expect(
      fetcher.mock.calls.filter(([path]) =>
        (typeof path === "string" ? path : path.url).endsWith("/replay"),
      ),
    ).toHaveLength(3);
  });

  it("repairs a lost final event at the full deadline despite successful renewals", async () => {
    const missing = {
      ...row,
      id: "missing",
      createdSequence: 11,
      updatedSequence: 11,
    };
    const sockets = liveSocket();
    let lastSuccessfulCatchUp = 0;
    const responses = vi.fn().mockImplementation(() => {
      lastSuccessfulCatchUp = Date.now();
      return replay(10);
    });
    vi.stubGlobal("fetch", ticketFetch(responses));
    connection();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(responses).toHaveBeenCalledTimes(1);
    const repairAt = lastSuccessfulCatchUp + 60_000;
    await vi.advanceTimersByTimeAsync(28_000);
    expect(responses).toHaveBeenCalledTimes(1);
    expect(sockets.at(-1)?.readyState).toBe(Socket.OPEN);
    responses.mockResolvedValue(
      Response.json({
        kind: "replay",
        events: [{ operation: "send", sequence: 11, message: missing }],
        cursor: { ...cursor, sequence: 11 },
        highWater: 11,
        hasMore: false,
      }),
    );
    await vi.advanceTimersByTimeAsync(repairAt - Date.now() - 1);
    expect(responses).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(responses).toHaveBeenCalledTimes(2);
    expect(client.getQueryData<Timeline>(key)?.messages).toEqual([
      row,
      missing,
    ]);
  });

  it("does not postpone repair for a page budget or a failed fallback", async () => {
    const fetcher = vi.fn().mockImplementation(() => replay(10, true));
    vi.stubGlobal("fetch", fetcher);
    const active = connection();
    vi.stubGlobal("navigator", { onLine: true });
    await vi.advanceTimersByTimeAsync(20_000);
    await active.reconcile();
    expect(fetcher).toHaveBeenCalledTimes(12);
    fetcher.mockRejectedValue(new TypeError("Replay unavailable"));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetcher).toHaveBeenCalledTimes(13);
    fetcher.mockImplementation(() => Promise.resolve(replay(10)));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(14);
  });

  it("keeps navigation holds and restarts repair after catch-up of held history", async () => {
    const fetcher = vi
      .fn()
      .mockImplementation(() => Promise.resolve(replay(10)));
    vi.stubGlobal("fetch", fetcher);
    client.setQueryData(key, { ...state, mode: "historical" });
    const active = connection();
    vi.stubGlobal("navigator", { onLine: true });
    const hold = active.holdReplay();
    await vi.advanceTimersByTimeAsync(80_000);
    expect(fetcher).not.toHaveBeenCalled();
    hold.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(client.getQueryData<Timeline>(key)).toMatchObject({
      messages: [row],
      mode: "historical",
    });
  });

  it("requires complete replay after a reset snapshot before postponing repair", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        failureResponse(
          { kind: "reset_required", reason: "floor" },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          kind: "snapshot",
          messages: [row],
          cursor,
          nextBefore: null,
          readSequence: 5,
        }),
      )
      .mockRejectedValueOnce(new TypeError("Replay unavailable"))
      .mockImplementation(() => Promise.resolve(replay(10)));
    vi.stubGlobal("fetch", fetcher);
    const active = connection();
    vi.stubGlobal("navigator", { onLine: true });
    await vi.advanceTimersByTimeAsync(20_000);
    await active.reconcile();
    expect(fetcher).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("never rearms repair from a successful response after disposal", async () => {
    const pending = deferred<Response>();
    const fetcher = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetcher);
    const active = connection();
    vi.stubGlobal("navigator", { onLine: true });
    const reading = active.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledOnce();
    active.dispose();
    const timers = vi.getTimerCount();
    pending.resolve(replay(20));
    await reading;
    expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(client.getQueryData<Timeline>(key)?.cursor.sequence).toBe(10);
  });

  it("does not postpone repair for a replay rejected by the current generation", async () => {
    const pending = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(() => Promise.resolve(replay(10)));
    vi.stubGlobal("fetch", fetcher);
    const active = connection();
    vi.stubGlobal("navigator", { onLine: true });
    await vi.advanceTimersByTimeAsync(20_000);
    const reading = active.reconcile();
    await vi.advanceTimersByTimeAsync(0);
    const replacement = { ...cursor, generation: crypto.randomUUID() };
    client.setQueryData(key, { ...state, cursor: replacement });
    pending.resolve(replay(20));
    await reading;
    expect(client.getQueryData<Timeline>(key)?.cursor).toEqual(replacement);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("timeline replay ownership", () => {
  it.each(["following", "paused", "historical"] as const)(
    "refills retired history through authoritative replay only while following (%s)",
    async (mode) => {
      const account: AccountFence = {
        origin: "https://vaskel.test",
        accountId: "account",
        accountEpoch: crypto.randomUUID(),
        cacheId: crypto.randomUUID(),
      };
      let scope: ScopeCapture = {
        ...account,
        owner,
        generation: cursor.generation,
        retirementRevision: 0,
        scopeEpoch: crypto.randomUUID(),
      };
      const disk: { current: HistoryProjection | null } = { current: null };
      const storage = {
        captureScope: vi.fn(async () => ({ kind: "ok", value: scope })),
        authorizeScope: vi.fn(async (capture: ScopeCapture) =>
          capture.scopeEpoch === scope.scopeEpoch
            ? { kind: "ok", value: scope }
            : { kind: "stale" },
        ),
        save: vi.fn(async (capture: ScopeCapture, value: HistoryProjection) => {
          if (capture.scopeEpoch !== scope.scopeEpoch) return { kind: "stale" };
          disk.current = value;
          return { kind: "ok" };
        }),
        invalidateOwner: vi.fn(async () => {
          disk.current = null;
          scope = { ...scope, scopeEpoch: crypto.randomUUID() };
          return { kind: "ok" };
        }),
      } as unknown as HistoryCache;
      const projection = new TimelineProjection(
        account,
        owner,
        () => ({
          owner: "Server",
          channel: "General",
          authors: [{ id: "author", label: "Author" }],
        }),
        storage,
      );
      disposals.push(() => projection.dispose());
      const accepted = vi.spyOn(projection, "accepted");
      const sockets = liveSocket();
      vi.stubGlobal(
        "fetch",
        ticketFetch(() => replay(10)),
      );
      connection({ projection });
      await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
      const oldLease = await projection.capture();
      expect(disk.current?.messages).toEqual([row]);
      client.setQueryData<Timeline>(key, (current) => ({
        ...current!,
        mode,
      }));
      await storage.invalidateOwner(scope);
      expect(disk.current).toBeNull();
      accepted.mockClear();
      hintContent();
      await vi.waitFor(() => expect(accepted).toHaveBeenCalledOnce());
      await projection.capture();
      expect(disk.current?.messages ?? null).toEqual(
        mode === "following" ? [row] : null,
      );
      expect(sockets).toHaveLength(1);
      const saves = vi.mocked(storage.save).mock.calls.length;
      projection.accepted(oldLease, state, true);
      await projection.capture();
      expect(storage.save).toHaveBeenCalledTimes(saves);
    },
  );

  it("keeps a complete held range when a later real socket frame precedes paged replay of missing earlier sends", async () => {
    const sockets = liveSocket();
    const message = (sequence: number) => ({
      ...row,
      id: `message-${sequence}`,
      createdSequence: sequence,
      updatedSequence: sequence,
    });
    const events = (first: number, last: number) =>
      Array.from({ length: last - first + 1 }, (_, index) => ({
        operation: "send",
        sequence: first + index,
        message: message(first + index),
      }));
    const original = latestTimeline({
      messages: events(201, 400).map((event) => event.message),
      cursor: { ...cursor, sequence: 400 },
      nextBefore: 201,
      readSequence: 0,
    });
    client.setQueryData(key, original);
    const held = deferred<Response>();
    const page = (first: number, last: number, hasMore: boolean) =>
      Response.json({
        kind: "replay",
        events: events(first, last),
        cursor: { ...cursor, sequence: last },
        highWater: 601,
        hasMore,
      });
    const replies = [
      Promise.resolve(replay(400)),
      held.promise,
      Promise.resolve(page(501, 600, true)),
      Promise.resolve(page(601, 601, false)),
    ];
    vi.stubGlobal(
      "fetch",
      ticketFetch(() => replies.shift() ?? replay(601)),
    );
    const status = vi.fn();
    connection({ status });
    await vi.waitFor(() =>
      expect(status).toHaveBeenLastCalledWith("connected"),
    );
    // 600 is still missing locally, so this newer frame cannot insert itself.
    sockets[0]!.receive({
      data: committed(601, 600, 0, message(601)),
    } as MessageEvent<string>);
    expect(client.getQueryData<Timeline>(key)?.messages).toEqual(
      original.messages,
    );
    expect(client.getQueryData<Timeline>(key)?.lastCreatedSequence).toBe(601);
    client.setQueryData<Timeline>(key, (state) =>
      followTimeline(state!, false),
    );
    held.resolve(page(401, 500, true));
    await vi.waitFor(() =>
      expect(client.getQueryData<Timeline>(key)?.cursor.sequence).toBe(601),
    );
    expect(client.getQueryData<Timeline>(key)?.messages).toEqual(
      original.messages,
    );
    expect(client.getQueryData<Timeline>(key)?.readSequence).toBe(0);
  });

  it("exposes a transient replay failure and accepts an explicit reconciliation retry", async () => {
    const newer = {
      ...row,
      id: "next",
      createdSequence: 11,
      updatedSequence: 11,
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new TypeError("connection lost"))
        .mockResolvedValueOnce(
          Response.json({
            kind: "replay",
            events: [{ operation: "send", sequence: 11, message: newer }],
            cursor: { ...cursor, sequence: 11 },
            highWater: 11,
            hasMore: false,
          }),
        ),
    );
    const status = vi.fn();
    const active = connection({ status });
    vi.stubGlobal("navigator", { onLine: true });
    await active.reconcile();
    expect(status).toHaveBeenLastCalledWith("reconnecting");
    expect(client.getQueryData<Timeline>(key)?.messages).toEqual([row]);
    await active.reconcile();
    expect(client.getQueryData<Timeline>(key)?.messages).toEqual([row, newer]);
    expect(client.getQueryData<Timeline>(key)?.cursor.sequence).toBe(11);
  });

  it("drains an active page, holds further replay for Latest, then resumes from the installed snapshot once", async () => {
    const held = deferred<Response>();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(held.promise)
      .mockResolvedValue(replay(30));
    vi.stubGlobal("fetch", fetcher);
    const active = connection();
    const replaying = active.reconcile();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const hold = active.holdReplay();
    await active.reconcile();
    held.resolve(replay(20, true));
    await hold.settled;
    await replaying;
    expect(fetcher).toHaveBeenCalledOnce();
    expect(client.getQueryData<Timeline>(key)?.cursor.sequence).toBe(20);

    client.setQueryData(
      key,
      latestTimeline(
        { ...state, cursor: { ...cursor, sequence: 30 } },
        client.getQueryData(key),
      ),
    );
    hold.release();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const body = await fetchRequest(
      fetcher.mock.calls[1]![0] as Request,
      fetcher.mock.calls[1]![1] as RequestInit,
    ).json();
    expect(body.cursor.sequence).toBe(30);
    hold.release();
    expect(client.getQueryData<Timeline>(key)?.readSequence).toBe(5);
  });

  it("ignores an obsolete release and never resumes work after access loss or disposal", async () => {
    const fetcher = vi.fn().mockResolvedValue(replay(10));
    vi.stubGlobal("fetch", fetcher);
    const active = connection();
    const old = active.holdReplay();
    const current = active.holdReplay();
    old.release();
    await active.reconcile();
    expect(fetcher).not.toHaveBeenCalled();
    active.dispose();
    current.release();
    await active.reconcile();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("purges a replay-only off-window deletion after an already-running save commits and cannot repopulate its old body", async () => {
    const account: AccountFence = {
      origin: "https://vaskel.test",
      accountId: "account",
      accountEpoch: crypto.randomUUID(),
      cacheId: crypto.randomUUID(),
    };
    const capture: ScopeCapture = {
      ...account,
      owner,
      generation: cursor.generation,
      retirementRevision: 0,
      scopeEpoch: crypto.randomUUID(),
    };
    const disk: { current: HistoryProjection | null } = { current: null };
    const saveGate = deferred<void>();
    const storage = {
      captureScope: vi.fn(async () => ({ kind: "ok", value: capture })),
      authorizeScope: vi.fn(async () => ({ kind: "ok", value: capture })),
      save: vi.fn(async (_fence: unknown, projection: HistoryProjection) => {
        await saveGate.promise;
        disk.current = projection;
        return { kind: "ok" };
      }),
      invalidateOwner: vi.fn(async () => {
        disk.current = null;
        return { kind: "ok" };
      }),
    } as unknown as HistoryCache;
    const projection = new TimelineProjection(
      account,
      owner,
      () => ({
        owner: "Server",
        channel: "General",
        authors: [{ id: "author", label: "Author" }],
      }),
      storage,
    );
    const withhold = vi.spyOn(projection, "withhold");
    disposals.push(() => projection.dispose());
    const networkGate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockReturnValueOnce(networkGate.promise)
        .mockResolvedValue(replay(11)),
    );
    const active = connection({ projection });
    const reading = active.reconcile();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());

    const older = {
      ...row,
      id: "evicted",
      body: "Old saved body",
      createdSequence: 1,
      updatedSequence: 1,
    };
    const staleLease = await projection.capture();
    projection.accepted(staleLease, { ...state, messages: [older, row] }, true);
    await vi.waitFor(() => expect(storage.save).toHaveBeenCalledOnce());
    networkGate.resolve(
      Response.json({
        kind: "replay",
        events: [
          {
            operation: "delete",
            sequence: 11,
            message: {
              ...older,
              body: null,
              version: 2,
              updatedSequence: 11,
              deletedAt: 11,
              reactions: [],
              mentions: [],
            },
          },
        ],
        cursor: { ...cursor, sequence: 11 },
        highWater: 11,
        hasMore: false,
      }),
    );
    // withhold() queues behind the held save; a delayed commit must still be purged.
    await vi.waitFor(() => expect(withhold).toHaveBeenCalledOnce());
    expect(storage.invalidateOwner).not.toHaveBeenCalled();
    saveGate.resolve();
    await reading;
    expect(storage.invalidateOwner).toHaveBeenCalledOnce();
    // A fresh trailing replay reauthorizes only the current resident body.
    expect(disk.current?.messages).toEqual([row]);
    expect(disk.current?.cursor.sequence).toBe(11);
    expect(client.getQueryData<Timeline>(key)?.messages).toEqual([row]);
    expect(client.getQueryData<Timeline>(key)?.lastMutationSequence).toBe(11);
    projection.accepted(staleLease, { ...state, messages: [older, row] }, true);
    await active.reconcile();
    await projection.capture();
    expect(disk.current?.messages).toEqual([row]);
    expect(disk.current?.cursor.sequence).toBe(11);
  });

  it("replays on every content hint for its owner, even mid-replay, and keeps the held window and socket", async () => {
    const held = deferred<Response>();
    const replies = [
      Promise.resolve(replay(10)),
      held.promise,
      Promise.resolve(replay(12)),
    ];
    const fetcher = ticketFetch(() => replies.shift() ?? replay(12));
    const { sockets, active } = await connected(fetcher);
    const paused = followTimeline(client.getQueryData<Timeline>(key)!, false);
    client.setQueryData(key, paused);
    const updatedAt = client.getQueryState(key)!.dataUpdatedAt;
    hintContent({ kind: "server", id: "elsewhere" });
    await new Promise((settle) => setTimeout(settle, 20));
    expect(fetcher).toHaveBeenCalledTimes(2);
    hintContent();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    hintContent();
    expect(client.getQueryState(key)!.dataUpdatedAt).toBe(updatedAt);
    held.resolve(replay(11));
    await vi.waitFor(() =>
      expect(client.getQueryData<Timeline>(key)?.cursor.sequence).toBe(12),
    );
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(sockets).toHaveLength(1);
    expect(client.getQueryData<Timeline>(key)).toMatchObject({
      mode: "paused",
      messages: paused.messages,
      windowVersion: paused.windowVersion,
    });
    active.dispose();
    expect(contentListeners.size).toBe(0);
  });
});
