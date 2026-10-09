import { deferred } from "@tests/shared/deferred";
import { describe, expect, it, vi } from "vitest";
import { TimelineProjection } from "@/client/features/cache/timeline-projection";
import type {
  AccountFence,
  HistoryCache,
  ScopeCapture,
} from "@/client/features/cache/model";
import {
  applyEvents,
  latestTimeline,
  type Timeline,
} from "@/client/features/chat/reconcile";

const owner = { kind: "server", id: "server-a" } as const;
const account: AccountFence = {
  origin: "https://vaskel.test",
  accountId: "account-a",
  accountEpoch: crypto.randomUUID(),
  cacheId: crypto.randomUUID(),
};
const capture: ScopeCapture = {
  ...account,
  owner,
  retirementRevision: 0,
  scopeEpoch: crypto.randomUUID(),
  generation: crypto.randomUUID(),
};
const state: Timeline = latestTimeline({
  cursor: {
    owner,
    channelId: "channel-a",
    generation: capture.generation!,
    sequence: 2,
  },
  nextBefore: null,
  readSequence: 0,
  messages: [
    {
      id: "message-a",
      channelId: "channel-a",
      authorId: "author-a",
      body: "Saved text",
      attachments: [],
      createdAt: 1,
      updatedAt: 1,
      deletedAt: null,
      reactions: [],
      mentions: [],
      createdSequence: 1,
      updatedSequence: 1,
      version: 1,
    },
  ],
});
const labels = () => ({
  owner: "Server",
  channel: "General",
  authors: [{ id: "author-a", label: "Author" }],
});
function cache() {
  return {
    captureScope: vi.fn(async () => ({ kind: "ok", value: capture })),
    authorizeScope: vi.fn(async () => ({ kind: "ok", value: capture })),
    save: vi.fn(async () => ({ kind: "ok" })),
    invalidateOwner: vi.fn(async () => ({ kind: "ok" })),
    recheck: vi.fn(async () => ({ kind: "ok" })),
  } as unknown as HistoryCache;
}

describe("accepted timeline projection boundaries", () => {
  it("keeps the saved recent window when browsing older rows, including after an old navigation lease completes", async () => {
    const storage = cache();
    const projection = new TimelineProjection(account, owner, labels, storage);
    const lease = await projection.capture();
    projection.accepted(lease, state, true);
    await projection.capture();
    projection.accepted(
      await projection.capture(),
      { ...state, mode: "paused", messages: [] },
      true,
    );
    projection.accepted(
      lease,
      { ...state, mode: "paused", messages: [] },
      false,
    );
    await projection.capture();
    expect(storage.save).toHaveBeenCalledOnce();
    expect(vi.mocked(storage.save).mock.calls[0]![1].messages).toEqual(
      state.messages,
    );
    projection.dispose();
  });

  it("exports the destination's captured quote even when its source is outside the window", async () => {
    const storage = cache();
    const projection = new TimelineProjection(account, owner, labels, storage);
    const quote = {
      source: {
        owner,
        channelId: "source-channel",
        messageId: "outside-window",
      },
      authorId: "source-author",
      version: 1,
      createdAt: 1,
      body: "Captured source outside the retained window",
      attachmentCount: 2,
    };
    const message = { ...state.messages[0]!, quote };
    projection.accepted(
      await projection.capture(),
      { ...state, messages: [message] },
      true,
    );
    await projection.capture();
    const saved = vi.mocked(storage.save).mock.calls[0]![1];
    expect(saved.messages[0]?.quote).toEqual(quote);
    expect(saved.messages[0]?.body).toBe("Saved text");
    projection.dispose();
  });

  it("rejects a delayed lease after unmount and detects missed owner invalidation on focus", async () => {
    const storage = cache();
    const held = deferred<Awaited<ReturnType<HistoryCache["captureScope"]>>>();
    vi.mocked(storage.captureScope).mockImplementationOnce(() => held.promise);
    const disposed = new TimelineProjection(account, owner, labels, storage);
    const pending = disposed.capture();
    await vi.waitFor(() => expect(storage.captureScope).toHaveBeenCalledOnce());
    disposed.dispose();
    held.resolve({ kind: "ok", value: capture });
    expect(await pending).toBeNull();
    const current = new TimelineProjection(account, owner, labels, storage);
    await current.capture();
    vi.mocked(storage.recheck).mockResolvedValue({ kind: "stale" });
    expect(await current.recheck()).toBe(false);
    expect(storage.recheck).toHaveBeenCalledWith(capture);
  });

  it("removes a saved body when paged replay observes its deletion below an ahead socket send, even if the next page never arrives", async () => {
    const storage = cache();
    const disk: { current: Timeline | null } = { current: null };
    vi.mocked(storage.save).mockImplementation(async (_fence, projection) => {
      disk.current = latestTimeline({ ...projection, readSequence: 0 });
      return { kind: "miss" };
    });
    vi.mocked(storage.invalidateOwner).mockImplementation(async () => {
      disk.current = null;
      return { kind: "ok", value: undefined };
    });
    const projection = new TimelineProjection(account, owner, labels, storage);
    projection.accepted(await projection.capture(), state, true);
    const replayLease = await projection.capture();
    expect(disk.current?.messages[0]?.body).toBe("Saved text");

    const socketSend = {
      ...state.messages[0]!,
      id: "message-b",
      body: "Later send",
      createdSequence: 5,
      updatedSequence: 5,
    };
    let timeline = applyEvents(state, [
      { operation: "send", sequence: 5, message: socketSend },
    ]);
    const deletion = {
      ...state.messages[0]!,
      body: null,
      deletedAt: 3,
      reactions: [],
      mentions: [],
      updatedSequence: 3,
      version: 2,
    };
    // First replay page hasMore=true: it observes deletion 3, but has not reached send 5.
    timeline = applyEvents(
      timeline,
      [{ operation: "delete", sequence: 3, message: deletion }],
      { ...state.cursor, sequence: 3 },
    );
    projection.accepted(replayLease, timeline, false);
    const nextLease = await projection.capture();
    // Network loss here leaves no saved old body available to a cold reader.
    expect(disk.current).toBeNull();
    expect(storage.save).toHaveBeenCalledTimes(1);

    // Only a fresh, contiguous reconciliation can restore this channel's cache.
    timeline = applyEvents(timeline, [], { ...state.cursor, sequence: 5 });
    projection.accepted(replayLease, timeline, false);
    expect(storage.save).toHaveBeenCalledTimes(1);
    projection.accepted(nextLease, timeline, false);
    await projection.capture();
    expect(
      disk.current?.messages.find((message) => message.id === "message-a"),
    ).toMatchObject({ body: null, deletedAt: 3, version: 2 });
    expect(disk.current?.cursor.sequence).toBe(5);
  });

  it("rejects a producing request completed after disposal or observed edit invalidation", async () => {
    const storage = cache();
    const projection = new TimelineProjection(account, owner, labels, storage);
    const lease = await projection.capture();
    await projection.withhold();
    projection.accepted(lease, state, false);
    expect(storage.invalidateOwner).toHaveBeenCalledOnce();
    expect(storage.save).not.toHaveBeenCalled();
    const fresh = await projection.capture();
    projection.dispose();
    projection.accepted(fresh, state, true);
    const replacement = new TimelineProjection(account, owner, labels, storage);
    replacement.accepted(lease, state, true);
    expect(storage.save).not.toHaveBeenCalled();
  });

  it("purges after a held export commits, so an observed deletion cannot leave its old saved body", async () => {
    const storage = cache();
    const held = deferred<Awaited<ReturnType<HistoryCache["save"]>>>();
    vi.mocked(storage.save).mockImplementation(() => held.promise);
    const projection = new TimelineProjection(account, owner, labels, storage);
    projection.accepted(await projection.capture(), state, true);
    await vi.waitFor(() => expect(storage.save).toHaveBeenCalledOnce());
    const purge = projection.withhold();
    expect(storage.invalidateOwner).not.toHaveBeenCalled();
    held.resolve({ kind: "miss" });
    await purge;
    expect(storage.invalidateOwner).toHaveBeenCalledOnce();
  });
});
