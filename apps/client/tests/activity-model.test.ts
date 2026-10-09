import { beforeAll, describe, expect, it, vi } from "vitest";
import type { OwnerActivity } from "@vaskel/contracts/activity";
import type { ResourceSummary } from "@vaskel/contracts/directory";

let model: typeof import("@/client/features/activity/model");
beforeAll(async () => {
  // The API client reads the page origin at load; the model is pure otherwise.
  vi.stubGlobal("window", { location: { origin: "http://localhost" } });
  model = await import("@/client/features/activity/model");
});

const owner = { kind: "server" as const, id: "circle" };
const resources: ResourceSummary[] = [
  {
    owner,
    name: "Weekend regulars",
    version: 1,
    role: "member",
    channels: [
      {
        id: "general",
        name: "general",
        kind: "text",
        private: false,
        version: 1,
        topic: null,
        occupancy: null,
        position: 0,
      },
      {
        id: "lounge",
        name: "Lounge",
        kind: "media",
        private: false,
        version: 1,
        topic: null,
        occupancy: null,
        position: 1,
      },
    ],
  },
];
function activity(
  unreadCount: number,
  readSequence = 4,
  generation = "g1",
  mentionCount = 0,
): OwnerActivity {
  return {
    owner,
    generation,
    channels: [
      {
        channelId: "general",
        lastCreatedSequence: 9,
        readSequence,
        unreadCount,
        mentionCount,
        hasUnread: unreadCount > 0,
      },
    ],
    nextCursor: null,
  };
}

describe("activity model counts", () => {
  it("derives unread state and destinations from the server's capped count", () => {
    const result = model.activityModel(resources, [activity(3)], [], true);
    const key = model.channelIdentity(owner, "general");
    expect(result.counts.get(key)).toBe(3);
    expect(result.states.get(key)).toBe("unread");
    expect(result.unread).toEqual([
      expect.objectContaining({
        channelId: "general",
        channelName: "general",
        resourceName: "Weekend regulars",
        count: 3,
      }),
    ]);
    // Voice rooms never appear as unread destinations.
    expect(result.unread.some((item) => item.channelId === "lounge")).toBe(
      false,
    );
  });
  it("treats a zero count as read, lets the furthest read cursor decide duplicates, and ignores untrusted data", () => {
    const key = model.channelIdentity(owner, "general");
    const read = model.activityModel(resources, [activity(0)], [], true);
    expect(read.states.get(key)).toBe("read");
    expect(read.unread).toEqual([]);
    // The same owner delivered twice: the entry read up to the end wins.
    const overlapping = model.activityModel(
      resources,
      [activity(0, 9), activity(5, 0)],
      [],
      true,
    );
    expect(overlapping.counts.get(key)).toBe(0);
    expect(overlapping.unread).toEqual([]);
    const untrusted = model.activityModel(resources, [activity(5)], [], false);
    expect(untrusted.states.size).toBe(0);
    expect(untrusted.incomplete).toBe(true);
  });
  it("carries mention counts with the unread counts they belong to", () => {
    const key = model.channelIdentity(owner, "general");
    const named = model.activityModel(
      resources,
      [activity(3, 4, "g1", 2)],
      [],
      true,
    );
    expect(named.mentions.get(key)).toBe(2);
    expect(named.unread).toEqual([
      expect.objectContaining({ count: 3, mentionCount: 2 }),
    ]);
    // The entry read to the end decides both counts, not the stale one.
    const overlapping = model.activityModel(
      resources,
      [activity(0, 9, "g1", 0), activity(5, 0, "g1", 4)],
      [],
      true,
    );
    expect(overlapping.mentions.get(key)).toBe(0);
    // A read cursor at or past the last creation clears mentions as well.
    const caughtUp = model.activityModel(
      resources,
      [activity(4, 9, "g1", 4)],
      [],
      true,
    );
    expect(caughtUp.counts.get(key)).toBe(0);
    expect(caughtUp.mentions.get(key)).toBe(0);
    expect(caughtUp.states.get(key)).toBe("read");
    // Unmentioned unread rooms still report nothing to prefix their badge.
    expect(
      model.activityModel(resources, [activity(3)], [], true).mentions.get(key),
    ).toBe(0);
  });
});

describe("circles new to the viewer", () => {
  const bookClub = { kind: "server" as const, id: "book-club" };
  const room = (id: string, kind: "text" | "media" = "text") => ({
    id,
    name: id,
    kind,
    private: false,
    version: 1,
    topic: null,
    occupancy: null,
    position: 0,
  });
  const twoCircles: ResourceSummary[] = [
    ...resources,
    {
      owner: bookClub,
      name: "Book club",
      version: 1,
      role: "member",
      channels: [room("hello"), room("reading-list"), room("quiet", "media")],
    },
  ];
  const positions = (
    channels: [id: string, last: number, read: number, unread: number][],
  ): OwnerActivity => ({
    owner: bookClub,
    generation: "g2",
    channels: channels.map(([channelId, last, read, unread]) => ({
      channelId,
      lastCreatedSequence: last,
      readSequence: read,
      unreadCount: unread,
      mentionCount: 0,
      hasUnread: unread > 0,
    })),
    nextCursor: null,
  });

  it("marks a circle whose rooms were never opened as new and keeps its rooms out of the inbox", () => {
    const result = model.activityModel(
      twoCircles,
      [
        activity(3),
        positions([
          ["hello", 6, 0, 4],
          ["reading-list", 2, 0, 1],
        ]),
      ],
      [],
      true,
    );
    expect(result.newOwners).toEqual(new Set(["server:book-club"]));
    expect(result.fresh).toEqual(
      new Set([
        model.channelIdentity(bookClub, "hello"),
        model.channelIdentity(bookClub, "reading-list"),
      ]),
    );
    // The rooms are still unread and counted; only the inbox leaves them out.
    expect(result.states.get(model.channelIdentity(bookClub, "hello"))).toBe(
      "unread",
    );
    expect(result.counts.get(model.channelIdentity(bookClub, "hello"))).toBe(4);
    expect(result.unread.map((destination) => destination.channelId)).toEqual([
      "general",
    ]);
  });

  it("stops treating a circle as new once any room was opened, and never guesses without positions", () => {
    const opened = model.activityModel(
      twoCircles,
      [
        positions([
          ["hello", 6, 6, 0],
          ["reading-list", 2, 0, 1],
        ]),
      ],
      [],
      true,
    );
    expect(opened.newOwners.size).toBe(0);
    expect(opened.fresh.size).toBe(0);
    expect(opened.unread.map((destination) => destination.channelId)).toEqual([
      "reading-list",
    ]);
    // A room without a position leaves the circle's status unknown.
    const partial = model.activityModel(
      twoCircles,
      [positions([["hello", 6, 0, 4]])],
      [],
      true,
    );
    expect(partial.newOwners.size).toBe(0);
    expect(partial.fresh.size).toBe(0);
    // An empty new circle is new without any room being marked.
    const empty = model.activityModel(
      twoCircles,
      [
        positions([
          ["hello", 0, 0, 0],
          ["reading-list", 0, 0, 0],
        ]),
      ],
      [],
      true,
    );
    expect(empty.newOwners).toEqual(new Set(["server:book-club"]));
    expect(empty.fresh.size).toBe(0);
    expect(empty.unread).toEqual([]);
    expect(
      model.activityModel(
        twoCircles,
        [positions([["hello", 6, 0, 4]])],
        [],
        false,
      ).newOwners.size,
    ).toBe(0);
  });
});

describe("remembered new circles", () => {
  const bookClub = { kind: "server" as const, id: "book-club" };
  const room = (id: string) => ({
    id,
    name: id,
    kind: "text" as const,
    private: false,
    version: 1,
    topic: null,
    occupancy: null,
    position: 0,
  });
  const withBookClub: ResourceSummary[] = [
    ...resources,
    {
      owner: bookClub,
      name: "Book club",
      version: 1,
      role: "member",
      channels: [room("hello"), room("reading-list")],
    },
  ];
  const positions = (
    channels: [id: string, last: number, read: number, unread: number][],
  ): OwnerActivity => ({
    owner: bookClub,
    generation: "g2",
    channels: channels.map(([channelId, last, read, unread]) => ({
      channelId,
      lastCreatedSequence: last,
      readSequence: read,
      unreadCount: unread,
      mentionCount: 0,
      hasUnread: unread > 0,
    })),
    nextCursor: null,
  });
  const opened = positions([
    ["hello", 6, 6, 0],
    ["reading-list", 2, 0, 1],
  ]);

  it("keeps a remembered circle new after its first room is opened", () => {
    const remembered = new Map([["server:book-club", "new" as const]]);
    const result = model.activityModel(
      withBookClub,
      [opened],
      [],
      true,
      remembered,
    );
    expect(result.newOwners).toEqual(new Set(["server:book-club"]));
    expect(result.settledOwners.size).toBe(0);
    // The opened room dropped its mark; the other stays new and out of the inbox.
    expect(result.fresh).toEqual(
      new Set([model.channelIdentity(bookClub, "reading-list")]),
    );
    expect(result.unread).toEqual([]);
    // Offline, the remembered state still holds without marking rooms.
    const offline = model.activityModel(
      withBookClub,
      [],
      [],
      false,
      remembered,
    );
    expect(offline.newOwners).toEqual(new Set(["server:book-club"]));
    expect(offline.fresh.size).toBe(0);
  });

  it("ends the hint when dismissed or when every room has been opened", () => {
    const dismissed = new Map([["server:book-club", "done" as const]]);
    const result = model.activityModel(
      withBookClub,
      [opened],
      [],
      true,
      dismissed,
    );
    expect(result.newOwners.size).toBe(0);
    expect(result.fresh.size).toBe(0);
    expect(result.unread.map((destination) => destination.channelId)).toEqual([
      "reading-list",
    ]);
    const settled = model.activityModel(
      withBookClub,
      [
        positions([
          ["hello", 6, 6, 0],
          ["reading-list", 2, 2, 0],
        ]),
      ],
      [],
      true,
      new Map([["server:book-club", "new" as const]]),
    );
    expect(settled.settledOwners).toEqual(new Set(["server:book-club"]));
    expect(settled.newOwners.size).toBe(0);
  });
});

describe("mentions inside a new circle", () => {
  it("keeps a mentioned room unread with its pill and in the inbox while the others stay new", () => {
    const bookClub = { kind: "server" as const, id: "book-club" };
    const room = (id: string) => ({
      id,
      name: id,
      kind: "text" as const,
      private: false,
      version: 1,
      topic: null,
      occupancy: null,
      position: 0,
    });
    const result = model.activityModel(
      [
        {
          owner: bookClub,
          name: "Book club",
          version: 1,
          role: "member",
          channels: [room("hello"), room("mention-ordering")],
        },
      ],
      [
        {
          owner: bookClub,
          generation: "g3",
          channels: [
            {
              channelId: "hello",
              lastCreatedSequence: 6,
              readSequence: 0,
              unreadCount: 4,
              mentionCount: 0,
              hasUnread: true,
            },
            {
              channelId: "mention-ordering",
              lastCreatedSequence: 3,
              readSequence: 0,
              unreadCount: 1,
              mentionCount: 1,
              hasUnread: true,
            },
          ],
          nextCursor: null,
        },
      ],
      [],
      true,
    );
    expect(result.newOwners).toEqual(new Set(["server:book-club"]));
    expect(result.fresh).toEqual(
      new Set([model.channelIdentity(bookClub, "hello")]),
    );
    expect(result.unread).toEqual([
      expect.objectContaining({
        channelId: "mention-ordering",
        mentionCount: 1,
      }),
    ]);
  });
});
