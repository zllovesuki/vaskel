import { deferred } from "@tests/shared/deferred";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { Message, MessageEvent } from "@vaskel/contracts/messaging";
import {
  applyEvents,
  followTimeline,
  hasNewerMessages,
  latestTimeline,
  marksRead,
  observeEvents,
  observeReceipt,
  TIMELINE_MESSAGE_LIMIT,
  type Timeline,
  type TimelineAround,
  type TimelineSnapshot,
} from "@/client/features/chat/reconcile";
import {
  navigateAroundTimeline,
  navigateTimeline,
  refreshTimelineSnapshot,
} from "@/client/features/chat/timeline-navigation";

const owner = { kind: "server", id: "server" } as const;
const cursor = {
  owner,
  channelId: "general",
  generation: crypto.randomUUID(),
  sequence: 0,
};
const key = ["timeline", "general"];
function row(sequence: number): Message {
  return {
    id: `message-${sequence}`,
    channelId: "general",
    authorId: "author",
    body: `Message ${sequence}`,
    attachments: [],
    createdAt: sequence,
    updatedAt: sequence,
    deletedAt: null,
    reactions: [],
    mentions: [],
    createdSequence: sequence,
    updatedSequence: sequence,
    version: 1,
  };
}
function rows(first: number, last: number) {
  return Array.from({ length: last - first + 1 }, (_, index) =>
    row(first + index),
  );
}
function sends(first: number, last: number): MessageEvent[] {
  return rows(first, last).map((message) => ({
    operation: "send",
    message,
    sequence: message.createdSequence,
  }));
}
function snapshot(first: number, last: number, head = last): TimelineSnapshot {
  return {
    kind: "snapshot",
    messages: rows(first, last),
    cursor: { ...cursor, sequence: head },
    nextBefore: first > 1 ? first : null,
    readSequence: 0,
  };
}
/**
 * The owner's window around one message. Its boundaries are rows inside the
 * page, as the actor reports them: the first row to page back from and, when
 * messages remain after it, the last row to continue forward from.
 */
function around(
  first: number,
  last: number,
  head = last,
  more = false,
): TimelineAround {
  return {
    kind: "around",
    messages: rows(first, last),
    cursor: { ...cursor, sequence: head },
    nextBefore: first > 1 ? first : null,
    nextAfter: more ? last : null,
    readSequence: 0,
  };
}
/** A channel holding messages 1..`last`, answering a forward or opening anchor. */
function aroundChannel(last: number, limit = 40) {
  return (sequence: number): TimelineAround => {
    const start = Math.max(
      1,
      Math.min(sequence - Math.floor((limit - 1) / 2), last - limit + 1),
    );
    const end = Math.min(last, start + limit - 1);
    return around(start, end, last, end < last);
  };
}

function cache(state: Timeline) {
  const client = new QueryClient();
  client.setQueryData(key, state);
  return {
    read: () => client.getQueryData<Timeline>(key),
    write: (state: Timeline) => {
      client.setQueryData(key, state);
    },
    current: () => true,
    visibleSequence: () => undefined,
    close: () => client.clear(),
  };
}

describe("bounded resident timeline", () => {
  it("retains a stable window through sustained socket/replay traffic without confusing observed, contiguous and read positions", () => {
    let state = { ...latestTimeline(snapshot(1, 40)), readSequence: 12 };
    for (let start = 41; start < 8_001; start += 20) {
      const events = sends(start, start + 19);
      const before = state.cursor.sequence;
      state = applyEvents(state, events);
      expect(state.cursor.sequence).toBe(before);
      state = applyEvents(state, events, { ...cursor, sequence: start + 19 });
      expect(state.messages.length).toBeLessThanOrEqual(TIMELINE_MESSAGE_LIMIT);
      expect(state.lastCreatedSequence).toBe(start + 19);
      expect(state.readSequence).toBe(12);
    }
    expect(state.messages.map((message) => message.createdSequence)).toEqual(
      Array.from({ length: 200 }, (_, index) => 7_801 + index),
    );
    expect(state.nextBefore).toBe(7_801);
    // An old replay page or an identical accepted send cannot move the cursor
    // backward, duplicate a receipt's message, or reinstall an evicted row.
    state = applyEvents(state, [...sends(1, 20), ...sends(7_990, 8_000)], {
      ...cursor,
      sequence: 20,
    });
    expect(state.cursor.sequence).toBe(8_000);
    expect(state.messages).toHaveLength(200);
    expect(state.messages[0]?.createdSequence).toBe(7_801);
  });

  it("keeps the reading range and captured quote during a busy tail while resident edits and tombstones still reconcile", () => {
    let state = applyEvents(latestTimeline(snapshot(1, 40)), sends(41, 300), {
      ...cursor,
      sequence: 300,
    });
    state.messages[20] = {
      ...state.messages[20]!,
      quote: {
        source: { owner, channelId: "elsewhere", messageId: "not-resident" },
        authorId: "other",
        body: "Captured original",
        createdAt: 1,
        version: 1,
        attachmentCount: 1,
      },
    };
    state = followTimeline(state, false);
    state = applyEvents(state, sends(301, 4_000), {
      ...cursor,
      sequence: 4_000,
    });
    const edited = {
      ...row(150),
      body: "Revised",
      version: 2,
      updatedSequence: 4_001,
    };
    const deleted = {
      ...row(151),
      body: null,
      deletedAt: 4_002,
      reactions: [],
      mentions: [],
      version: 2,
      updatedSequence: 4_002,
    };
    state = applyEvents(
      state,
      [
        { operation: "edit", sequence: 4_001, message: edited },
        { operation: "delete", sequence: 4_002, message: deleted },
        {
          operation: "delete",
          sequence: 4_003,
          message: {
            ...row(50),
            body: null,
            deletedAt: 4_003,
            reactions: [],
            mentions: [],
            version: 2,
            updatedSequence: 4_003,
          },
        },
      ],
      { ...cursor, sequence: 4_003 },
    );
    // Retry-era socket/replay sends must not resurrect edited or deleted text.
    state = applyEvents(state, sends(150, 151));
    expect(state.messages).toHaveLength(200);
    expect(state.messages[0]?.createdSequence).toBe(101);
    expect(state.messages.at(-1)?.createdSequence).toBe(300);
    expect(state.messages.find((message) => message.id === edited.id)).toEqual(
      edited,
    );
    expect(state.messages.find((message) => message.id === deleted.id)).toEqual(
      deleted,
    );
    expect(state.messages[20]?.quote?.body).toBe("Captured original");
    expect(state.lastCreatedSequence).toBe(4_000);
    expect(state.lastMutationSequence).toBe(4_003);
    expect(state.readSequence).toBe(0);
    expect(hasNewerMessages(state)).toBe(true);
    expect(followTimeline(state, true).mode).toBe("paused");
  });

  it("observes a later socket send without opening a gap, then keeps the reading anchor when missing sends replay after a pause", () => {
    const original = applyEvents(
      latestTimeline(snapshot(1, 40)),
      sends(41, 400),
      { ...cursor, sequence: 400 },
    );
    let state = observeEvents(original, sends(601, 601));
    expect(state.messages).toEqual(original.messages);
    expect(state.lastCreatedSequence).toBe(601);
    expect(state.cursor.sequence).toBe(400);
    state = followTimeline(state, false);
    state = applyEvents(state, sends(401, 500), { ...cursor, sequence: 500 });
    state = applyEvents(state, sends(501, 601), { ...cursor, sequence: 601 });
    expect(state.messages).toEqual(original.messages);
    expect(state.messages).toHaveLength(200);
    expect(state.cursor.sequence).toBe(601);
    expect(hasNewerMessages(state)).toBe(true);
  });

  it("keeps following during bottom scroll notifications while socket sends remain ahead of replay", () => {
    let state = latestTimeline(snapshot(1, 40));
    for (let start = 41; start <= 301; start += 20) {
      state = observeEvents(state, sends(start + 19, start + 19));
      state = followTimeline(state, true);
      expect(state.mode).toBe("following");
      state = applyEvents(state, sends(start, start + 9), {
        ...cursor,
        sequence: start + 9,
      });
      state = followTimeline(state, true);
      expect(state.mode).toBe("following");
      state = applyEvents(state, sends(start + 10, start + 19), {
        ...cursor,
        sequence: start + 19,
      });
    }
    expect(state.messages).toHaveLength(TIMELINE_MESSAGE_LIMIT);
    expect(state.messages.at(-1)?.createdSequence).toBe(320);
    expect(state.cursor.sequence).toBe(320);

    state = followTimeline(observeEvents(state, sends(321, 321)), false);
    expect(state.mode).toBe("paused");
    expect(followTimeline(state, true).mode).toBe("paused");
  });

  it("tracks a current mutation materialized through an earlier send event, even outside the held window", () => {
    const state = followTimeline(latestTimeline(snapshot(1, 40)), false);
    const updated = {
      ...row(50),
      body: null,
      deletedAt: 70,
      reactions: [],
      mentions: [],
      version: 2,
      updatedSequence: 70,
    };
    const next = applyEvents(
      state,
      [{ operation: "send", sequence: 50, message: updated }],
      { ...cursor, sequence: 50 },
    );
    expect(next.messages).toEqual(state.messages);
    expect(next.lastCreatedSequence).toBe(50);
    expect(next.lastMutationSequence).toBe(70);
    expect(next.cursor.sequence).toBe(50);
  });

  it("pages to the beginning with a bounded overlap and unchanged replay/read positions", async () => {
    const store = cache({
      ...latestTimeline(snapshot(561, 600)),
      readSequence: 550,
    });
    try {
      while (store.read()!.nextBefore !== null) {
        const anchor = store.read()!.messages[0]!.createdSequence;
        await navigateTimeline({
          ...store,
          direction: "older",
          visibleSequence: () => anchor,
          fetchSnapshot: async (before) =>
            snapshot(Math.max(1, before! - 40), before! - 1, 700),
        });
        expect(store.read()!.messages.length).toBeLessThanOrEqual(200);
        expect(
          store
            .read()!
            .messages.some((message) => message.createdSequence === anchor),
        ).toBe(true);
        expect(store.read()!.cursor.sequence).toBe(600);
        expect(store.read()!.readSequence).toBe(550);
      }
      expect(store.read()!.messages[0]?.createdSequence).toBe(1);
      expect(store.read()!.messages.at(-1)?.createdSequence).toBe(200);
      expect(store.read()!.lastCreatedSequence).toBe(600);
      expect(hasNewerMessages(store.read()!)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("refetches a delayed old page after an off-window deletion, without lowering an intervening read", async () => {
    const store = cache(latestTimeline(snapshot(561, 600)));
    const held = deferred<TimelineSnapshot>();
    const deleted = {
      ...row(550),
      body: null,
      deletedAt: 601,
      reactions: [],
      mentions: [],
      version: 2,
      updatedSequence: 601,
    };
    const fresh = snapshot(521, 560, 602);
    fresh.messages = fresh.messages.map((message) =>
      message.id === deleted.id ? deleted : message,
    );
    const fetchSnapshot = vi
      .fn()
      .mockImplementationOnce(() => held.promise)
      .mockResolvedValueOnce(fresh);
    try {
      const loading = navigateTimeline({
        ...store,
        direction: "older",
        fetchSnapshot,
      });
      store.write({
        ...applyEvents(
          store.read()!,
          [{ operation: "delete", sequence: 601, message: deleted }],
          { ...cursor, sequence: 601 },
        ),
        readSequence: 590,
      });
      held.resolve(snapshot(521, 560, 600));
      await expect(loading).resolves.toBe(true);
      expect(fetchSnapshot).toHaveBeenCalledTimes(2);
      expect(
        store.read()!.messages.find((message) => message.id === deleted.id)
          ?.body,
      ).toBeNull();
      expect(store.read()!.cursor.sequence).toBe(601);
      expect(store.read()!.readSequence).toBe(590);
    } finally {
      store.close();
    }
  });

  it("discards an older response after Latest navigation and after the visible anchor moves outside its prospective range", async () => {
    const store = cache(latestTimeline(snapshot(401, 600)));
    const held = deferred<TimelineSnapshot>();
    try {
      const older = navigateTimeline({
        ...store,
        direction: "older",
        fetchSnapshot: () => held.promise,
      });
      await navigateTimeline({
        ...store,
        direction: "latest",
        fetchSnapshot: async () => snapshot(561, 600),
      });
      const installed = store.read();
      held.resolve(snapshot(361, 400, 600));
      await expect(older).resolves.toBe(false);
      expect(store.read()).toBe(installed);

      store.write(latestTimeline(snapshot(401, 600)));
      await expect(
        navigateTimeline({
          ...store,
          direction: "older",
          visibleSequence: () => 590,
          fetchSnapshot: async () => snapshot(361, 400, 600),
        }),
      ).resolves.toBe(false);
      expect(store.read()!.messages[0]?.createdSequence).toBe(401);
      expect(store.read()!.messages.at(-1)?.createdSequence).toBe(600);
    } finally {
      store.close();
    }
  });

  it("accepts Latest while socket sends continue and replays the omitted tail from its snapshot", async () => {
    const store = cache({
      ...latestTimeline(snapshot(161, 200, 600)),
      readSequence: 590,
      mode: "paused",
      lastCreatedSequence: 600,
    });
    const held = deferred<TimelineSnapshot>();
    try {
      const latest = navigateTimeline({
        ...store,
        direction: "latest",
        fetchSnapshot: () => held.promise,
      });
      // Contiguous replay is held by the connection; socket observations continue.
      store.write(applyEvents(store.read()!, sends(601, 1_000)));
      held.resolve(snapshot(611, 650));
      await expect(latest).resolves.toBe(true);
      expect(store.read()!.cursor.sequence).toBe(650);
      expect(store.read()!.lastCreatedSequence).toBe(1_000);
      expect(store.read()!.readSequence).toBe(590);
      store.write(
        applyEvents(store.read()!, sends(651, 1_000), {
          ...cursor,
          sequence: 1_000,
        }),
      );
      expect(store.read()!.messages).toHaveLength(200);
      expect(store.read()!.messages[0]?.createdSequence).toBe(801);
      expect(store.read()!.messages.at(-1)?.createdSequence).toBe(1_000);
      expect(hasNewerMessages(store.read()!)).toBe(false);
    } finally {
      store.close();
    }
  });

  it("reconciles an exact accepted-send receipt with either socket order and fences accepted mutations during a Latest hold", () => {
    const initial = latestTimeline(snapshot(1, 40));
    const receipt = { messageId: "message-41", sequence: 41, version: 1 };
    const receiptFirst = applyEvents(
      observeReceipt(initial, "send", receipt),
      sends(41, 41),
    );
    const eventFirst = observeReceipt(
      applyEvents(initial, sends(41, 41)),
      "send",
      receipt,
    );
    expect(receiptFirst).toEqual(eventFirst);
    const retry = observeReceipt(
      applyEvents(receiptFirst, sends(41, 41)),
      "send",
      receipt,
    );
    expect(
      retry.messages.filter((message) => message.id === receipt.messageId),
    ).toHaveLength(1);
    expect(retry.cursor.sequence).toBe(40);
    expect(retry.readSequence).toBe(0);
    const removed = observeReceipt(
      { ...retry, mode: "paused" },
      "remove-attachment",
      { ...receipt, sequence: 50, version: 2 },
    );
    expect(removed.lastMutationSequence).toBe(50);
    expect(removed.lastCreatedSequence).toBe(41);
    expect(removed.messages).toEqual(retry.messages);
  });

  it("gives a following window back when a jump fails, and leaves a held one held", async () => {
    const following = cache(latestTimeline(snapshot(561, 600)));
    await expect(
      navigateAroundTimeline({
        ...following,
        target: 100,
        fetchAround: async () => {
          throw new Error("gone");
        },
      }),
    ).rejects.toThrow("gone");
    // Nothing was installed, so the reader still follows the latest messages
    // and a new arrival is not withheld behind "Newer messages below".
    expect(following.read()!.mode).toBe("following");
    expect(following.read()!.messages.at(-1)?.createdSequence).toBe(600);
    const held = cache({
      ...latestTimeline(snapshot(561, 600)),
      mode: "paused",
    });
    await expect(
      navigateAroundTimeline({
        ...held,
        target: 100,
        fetchAround: async () => {
          throw new Error("gone");
        },
      }),
    ).rejects.toThrow("gone");
    expect(held.read()!.mode).toBe("paused");
  });

  it("opens at one message without advancing replay, lowering a read or following the tail", async () => {
    const store = cache({
      ...latestTimeline(snapshot(561, 600)),
      readSequence: 550,
    });
    try {
      await expect(
        navigateAroundTimeline({
          ...store,
          target: 100,
          fetchAround: async (sequence) =>
            around(sequence - 19, sequence + 20, 600, true),
        }),
      ).resolves.toBe(true);
      const state = store.read()!;
      expect(state.messages[0]?.createdSequence).toBe(81);
      expect(state.messages.at(-1)?.createdSequence).toBe(120);
      expect(state.nextBefore).toBe(81);
      expect(state.nextAfter).toBe(120);
      expect(state.mode).toBe("historical");
      // A historical read is not an authoritative latest snapshot: the
      // contiguous cursor, the read position and the observed creation stay.
      expect(state.cursor.sequence).toBe(600);
      expect(state.readSequence).toBe(550);
      expect(state.lastCreatedSequence).toBe(600);
      expect(hasNewerMessages(state)).toBe(true);
      // Paging earlier from the opened window keeps its forward anchor.
      await navigateTimeline({
        ...store,
        direction: "older",
        fetchSnapshot: async (before) =>
          snapshot(before! - 40, before! - 1, 600),
      });
      expect(store.read()!.messages[0]?.createdSequence).toBe(41);
      expect(store.read()!.nextAfter).toBe(120);
    } finally {
      store.close();
    }
  });

  it("pages forward from an opened window until the latest messages are resident", async () => {
    const store = cache({
      ...latestTimeline(snapshot(561, 600)),
      readSequence: 550,
    });
    // The owner answers each forward step with a window that reaches back into
    // the resident rows, so the transcript never gains a gap.
    const fetchAround = vi.fn(async (sequence: number) =>
      around(
        Math.max(1, sequence - 20),
        Math.min(600, sequence + 19),
        600,
        sequence + 19 < 600,
      ),
    );
    try {
      await navigateAroundTimeline({ ...store, target: 100, fetchAround });
      let steps = 0;
      while (store.read()!.nextAfter !== null) {
        const anchor = store.read()!.messages.at(-1)!.createdSequence;
        await expect(
          navigateAroundTimeline({
            ...store,
            target: "newer",
            visibleSequence: () => anchor,
            fetchAround,
          }),
        ).resolves.toBe(true);
        const state = store.read()!;
        expect(state.messages.length).toBeLessThanOrEqual(
          TIMELINE_MESSAGE_LIMIT,
        );
        // The window is contiguous, bounded and still historical.
        expect(state.messages.map((item) => item.createdSequence)).toEqual(
          Array.from(
            { length: state.messages.length },
            (_, index) => state.messages[0]!.createdSequence + index,
          ),
        );
        // The earlier-history anchor follows the oldest surviving row.
        expect(state.nextBefore).toBe(state.messages[0]!.createdSequence);
        expect(state.cursor.sequence).toBe(600);
        expect(state.readSequence).toBe(550);
        expect(state.mode).toBe(
          state.nextAfter === null ? "paused" : "historical",
        );
        expect(steps++).toBeLessThan(40);
      }
      const arrived = store.read()!;
      expect(arrived.messages.at(-1)?.createdSequence).toBe(600);
      expect(arrived.messages).toHaveLength(TIMELINE_MESSAGE_LIMIT);
      expect(arrived.messages[0]?.createdSequence).toBe(401);
      expect(arrived.nextBefore).toBe(401);
      // The forward pages never resume following by themselves; with no
      // unseen tail left, scrolling to the bottom does, and Jump to latest
      // remains the explicit way back.
      expect(arrived.mode).toBe("paused");
      expect(hasNewerMessages(arrived)).toBe(false);
      expect(followTimeline(arrived, true).mode).toBe("following");
      await navigateTimeline({
        ...store,
        direction: "latest",
        fetchSnapshot: async () => snapshot(561, 600),
      });
      expect(store.read()!.mode).toBe("following");
      expect(store.read()!.nextAfter).toBeNull();
    } finally {
      store.close();
    }
  });

  it("continues from the resident tail after paging earlier evicted the rows the owner's anchor named", async () => {
    const store = cache({
      ...latestTimeline(snapshot(561, 600, 600)),
      readSequence: 550,
    });
    const fetchAround = vi.fn(async (sequence: number) =>
      aroundChannel(600)(sequence),
    );
    try {
      await navigateAroundTimeline({ ...store, target: 500, fetchAround });
      expect(store.read()!.messages.at(-1)?.createdSequence).toBe(520);
      expect(store.read()!.nextAfter).toBe(520);
      // Five earlier pages take the window past its cap, which discards the
      // newest rows the owner's forward anchor named.
      for (let page = 0; page < 5; page++)
        await navigateTimeline({
          ...store,
          direction: "older",
          fetchSnapshot: async (before) =>
            snapshot(before! - 40, before! - 1, 600),
        });
      const held = store.read()!;
      expect(held.messages).toHaveLength(TIMELINE_MESSAGE_LIMIT);
      expect(held.messages.at(-1)?.createdSequence).toBe(480);
      // The forward anchor followed the surviving tail, so paging forward
      // continues the transcript instead of leaving 481-520 missing.
      expect(held.nextAfter).toBe(480);
      await expect(
        navigateAroundTimeline({ ...store, target: "newer", fetchAround }),
      ).resolves.toBe(true);
      expect(fetchAround).toHaveBeenLastCalledWith(480);
      const forward = store.read()!;
      expect(forward.messages.map((item) => item.createdSequence)).toEqual(
        Array.from(
          { length: forward.messages.length },
          (_, index) => forward.messages[0]!.createdSequence + index,
        ),
      );
      expect(forward.messages.at(-1)?.createdSequence).toBeGreaterThan(480);
      expect(forward.nextBefore).toBe(forward.messages[0]?.createdSequence);
      expect(forward.readSequence).toBe(550);
      expect(forward.cursor.sequence).toBe(600);
      // A page that begins after the resident tail would splice a gap.
      await expect(
        navigateAroundTimeline({
          ...store,
          target: "newer",
          fetchAround: async () => around(560, 599, 600, true),
        }),
      ).resolves.toBe(false);
      expect(store.read()!.messages).toEqual(forward.messages);
    } finally {
      store.close();
    }
  });

  it("marks read only from the authoritative latest window", () => {
    const latest = latestTimeline(snapshot(561, 600));
    expect(marksRead(latest, 600)).toBe(true);
    expect(marksRead(latest, 0)).toBe(false);
    // A held range shows history the reader never scrolled through: reading
    // there would clear a backlog they have not seen.
    const held: Timeline = { ...latest, mode: "paused" };
    expect(marksRead(held, 600)).toBe(false);
    // Even at the bottom of a jumped-to window, messages remain after it.
    const jumped: Timeline = { ...latest, nextAfter: 320 };
    expect(marksRead(jumped, 320)).toBe(false);
    expect(marksRead({ ...latest, readSequence: 600 }, 600)).toBe(false);
  });

  it("keeps a near-tail jump held through automatic bottom scrolling until Latest", async () => {
    const store = cache(latestTimeline(snapshot(561, 600)));
    try {
      await navigateAroundTimeline({
        ...store,
        target: 595,
        fetchAround: async () => around(561, 600),
      });
      // The page includes the newest row, but opening a permalink did not
      // express an intent to read the intervening backlog.
      store.write(followTimeline(store.read()!, true));
      expect(store.read()!.nextAfter).toBeNull();
      expect(store.read()!.mode).toBe("historical");
      expect(marksRead(store.read()!, 600)).toBe(false);
      store.write(
        applyEvents(store.read()!, sends(601, 601), {
          ...cursor,
          sequence: 601,
        }),
      );
      expect(store.read()!.messages.at(-1)?.createdSequence).toBe(600);
      await navigateTimeline({
        ...store,
        direction: "latest",
        fetchSnapshot: async () => snapshot(562, 601),
      });
      expect(store.read()!.mode).toBe("following");
      expect(marksRead(store.read()!, 601)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("discards a forward page once navigation moved on or the reader's row would leave the window", async () => {
    const store = cache(latestTimeline(snapshot(561, 600)));
    const held = deferred<TimelineAround>();
    try {
      await navigateAroundTimeline({
        ...store,
        target: 100,
        fetchAround: async () => around(81, 120, 600, true),
      });
      const opened = store.read();
      const delayed = navigateAroundTimeline({
        ...store,
        target: "newer",
        fetchAround: () => held.promise,
      });
      // The reader jumped somewhere else while that page was in flight.
      await navigateAroundTimeline({
        ...store,
        target: 300,
        fetchAround: async () => around(281, 320, 600, true),
      });
      const installed = store.read();
      held.resolve(around(101, 140, 600, true));
      await expect(delayed).resolves.toBe(false);
      expect(store.read()).toBe(installed);
      expect(store.read()!.messages[0]?.createdSequence).toBe(281);

      // A page that would evict the row the reader scrolled to is refused.
      store.write({ ...opened!, messages: rows(81, 280), nextAfter: 280 });
      await expect(
        navigateAroundTimeline({
          ...store,
          target: "newer",
          visibleSequence: () => 81,
          fetchAround: async () => around(261, 300, 600, true),
        }),
      ).resolves.toBe(false);
      expect(store.read()!.messages[0]?.createdSequence).toBe(81);
      expect(store.read()!.messages.at(-1)?.createdSequence).toBe(280);
      // A page that does not reach the held rows would splice a gap.
      store.write(opened!);
      await expect(
        navigateAroundTimeline({
          ...store,
          target: "newer",
          fetchAround: async () => around(200, 239, 600, true),
        }),
      ).resolves.toBe(false);
      expect(store.read()!.messages.at(-1)?.createdSequence).toBe(120);
      expect(store.read()!.nextAfter).toBe(120);
    } finally {
      store.close();
    }
  });

  it("re-requests an opened window that raced a mutation and refuses another generation", async () => {
    const store = cache({
      ...latestTimeline(snapshot(561, 600)),
      lastMutationSequence: 602,
    });
    try {
      const stale = vi.fn(async () => around(81, 120, 600, true));
      await expect(
        navigateAroundTimeline({ ...store, target: 100, fetchAround: stale }),
      ).rejects.toThrow();
      expect(stale).toHaveBeenCalledTimes(3);
      expect(store.read()!.messages[0]?.createdSequence).toBe(561);

      const current = vi
        .fn()
        .mockResolvedValueOnce(around(81, 120, 600, true))
        .mockResolvedValueOnce(around(81, 120, 602, true));
      await expect(
        navigateAroundTimeline({ ...store, target: 100, fetchAround: current }),
      ).resolves.toBe(true);
      expect(current).toHaveBeenCalledTimes(2);
      expect(store.read()!.messages[0]?.createdSequence).toBe(81);

      await expect(
        navigateAroundTimeline({
          ...store,
          target: 100,
          fetchAround: async () => ({
            ...around(81, 120, 120, true),
            cursor: {
              ...cursor,
              generation: crypto.randomUUID(),
              sequence: 120,
            },
          }),
        }),
      ).rejects.toThrow();
      expect(store.read()!.cursor.generation).toBe(cursor.generation);
    } finally {
      store.close();
    }
  });

  it("keeps the old range on request failure, rejects obsolete access/generation results and bounds conflicting-snapshot retries", async () => {
    const original = latestTimeline(snapshot(561, 600));
    const store = cache(original);
    try {
      await expect(
        navigateTimeline({
          ...store,
          direction: "latest",
          fetchSnapshot: async () => {
            throw new Error("offline");
          },
        }),
      ).rejects.toThrow("offline");
      expect(store.read()!.messages).toEqual(original.messages);
      const wrongGeneration = {
        ...snapshot(1, 40),
        cursor: { ...cursor, generation: crypto.randomUUID(), sequence: 40 },
      };
      await expect(
        navigateTimeline({
          ...store,
          direction: "latest",
          fetchSnapshot: async () => wrongGeneration,
        }),
      ).rejects.toThrow();
      expect(store.read()!.cursor).toEqual(original.cursor);

      let permitted = true;
      const held = deferred<TimelineSnapshot>();
      const obsolete = navigateTimeline({
        ...store,
        current: () => permitted,
        direction: "older",
        fetchSnapshot: () => held.promise,
      });
      permitted = false;
      held.resolve(snapshot(521, 560, 600));
      await expect(obsolete).resolves.toBe(false);
      expect(store.read()!.messages).toEqual(original.messages);

      store.write({ ...store.read()!, lastMutationSequence: 602 });
      const stale = vi.fn(async () => snapshot(561, 600));
      await expect(
        navigateTimeline({
          ...store,
          direction: "latest",
          fetchSnapshot: stale,
        }),
      ).rejects.toThrow();
      expect(stale).toHaveBeenCalledTimes(3);
      expect(store.read()!.messages).toEqual(original.messages);
      expect(store.read()!.cursor.sequence).toBe(600);
      const restored = await refreshTimelineSnapshot(
        async () => wrongGeneration,
        store.read,
      );
      expect(latestTimeline(restored, store.read()).cursor).toEqual(
        wrongGeneration.cursor,
      );
    } finally {
      store.close();
    }
  });
});
