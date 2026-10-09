import { HISTORY_FORMAT } from "@/client/features/cache/model";
import { describe, expect, it } from "vitest";
import { MESSAGE_BYTE_LIMIT, type Message } from "@vaskel/contracts/messaging";
import {
  CachedSnapshotSchema,
  CacheInvalidationSchema,
  CacheMetaSchema,
  HISTORY_MESSAGE_LIMIT,
  snapshotByteLength,
  type CacheResult,
  type CachedSnapshot,
  type HistoryFence,
  type HistoryProjection,
} from "@/client/features/cache/model";
import { prepareSnapshot } from "@/client/features/cache/records";

const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const fence: HistoryFence = {
  origin: "https://vaskel.test",
  cacheId: id(1),
  accountEpoch: id(2),
  accountId: id(3),
  owner: { kind: "server", id: id(4) },
  retirementRevision: 0,
  scopeEpoch: id(5),
  generation: id(6),
};
const channelId = id(7);
const authorId = id(8);
function message(sequence: number, change: Partial<Message> = {}): Message {
  return {
    id: `message-${sequence}`,
    channelId,
    authorId,
    body: `保留したメッセージ ${sequence}`,
    attachments: [],
    version: 1,
    createdSequence: sequence,
    updatedSequence: sequence,
    createdAt: sequence,
    updatedAt: sequence,
    deletedAt: null,
    reactions: [],
    mentions: [],
    ...change,
  };
}
function projection(
  messages: Message[],
  sequence = Math.max(0, ...messages.map((item) => item.updatedSequence)),
): HistoryProjection {
  return {
    cursor: {
      owner: fence.owner,
      channelId,
      generation: fence.generation,
      sequence,
    },
    messages,
    nextBefore: null,
    labels: {
      owner: "友達",
      channel: "一般",
      authors: [{ id: authorId, label: "小林" }],
    },
  };
}
function accepted(result: CacheResult<CachedSnapshot>): CachedSnapshot {
  expect(result.kind).toBe("ok");
  if (result.kind !== "ok") throw new Error("Expected an accepted snapshot");
  return result.value;
}
function recounted(snapshot: CachedSnapshot): CachedSnapshot {
  snapshot.byteLength = snapshotByteLength(snapshot);
  return snapshot;
}

describe("persistent history record boundary", () => {
  it("requires an account epoch and consistent empty or active account metadata", () => {
    const empty = {
      format: HISTORY_FORMAT,
      retirementRevision: 0,
      cacheId: fence.cacheId,
      accountEpoch: fence.accountEpoch,
      accountId: null,
      accountLabel: null,
    };
    expect(CacheMetaSchema.safeParse(empty).success).toBe(true);
    const active = {
      ...empty,
      accountId: fence.accountId,
      accountLabel: "Reader",
    };
    expect(CacheMetaSchema.safeParse(active).success).toBe(true);
    const { accountEpoch: _accountEpoch, ...unmarked } = active;
    expect(CacheMetaSchema.safeParse(unmarked).success).toBe(false);
    expect(
      CacheMetaSchema.safeParse({ ...active, accountLabel: null }).success,
    ).toBe(false);
    const saved = accepted(
      prepareSnapshot(fence, projection([message(1)]), undefined, true, 100),
    );
    const { accountEpoch: _fenceEpoch, ...unmarkedFence } = fence;
    expect(
      CachedSnapshotSchema.safeParse({ ...saved, fence: unmarkedFence })
        .success,
    ).toBe(false);
  });

  it("retains a snapshot author label, then drops both quote and label with its destination tombstone", () => {
    const quote = {
      source: {
        owner: { kind: "server" as const, id: id(11) },
        channelId: id(12),
        messageId: "old-original",
      },
      authorId: id(13),
      body: "Quoted history",
      createdAt: 1,
      version: 1,
      attachmentCount: 1,
    };
    const input = projection([message(1, { quote })]);
    input.labels.authors.push({ id: id(13), label: "Quoted author" });
    const saved = accepted(prepareSnapshot(fence, input, undefined, true, 100));
    expect(saved.messages[0]?.quote).toEqual(quote);
    expect(saved.labels.authors).toContainEqual({
      id: id(13),
      label: "Quoted author",
    });
    const deletion = projection([
      message(1, { body: null, deletedAt: 2, version: 2, updatedSequence: 2 }),
    ]);
    const deleted = accepted(
      prepareSnapshot(fence, deletion, saved, false, 101),
    );
    expect(deleted.messages[0]?.quote).toBeUndefined();
    expect(deleted.labels.authors).not.toContainEqual({
      id: id(13),
      label: "Quoted author",
    });
    input.cursor.sequence = 2;
    const stale = accepted(prepareSnapshot(fence, input, deleted, false, 102));
    expect(stale.messages[0]?.quote).toBeUndefined();
  });

  it("retains the newest 200 accepted messages and only their author labels", () => {
    const input = projection(
      Array.from({ length: 215 }, (_, index) =>
        message(index + 1, index < 15 ? { authorId: id(9) } : {}),
      ),
    );
    input.labels.authors.push(
      { id: id(9), label: "Evicted author" },
      { id: id(10), label: "Unretained directory entry" },
    );
    const saved = accepted(prepareSnapshot(fence, input, undefined, true, 100));
    expect(saved.messages).toHaveLength(HISTORY_MESSAGE_LIMIT);
    expect(saved.messages[0]?.createdSequence).toBe(16);
    expect(saved.messages.at(-1)?.createdSequence).toBe(215);
    expect(saved.nextBefore).toBe(16);
    expect(saved.labels.authors).toEqual([{ id: authorId, label: "小林" }]);
  });

  it("keeps higher versions and deletion tombstones while replacement removes previous-window IDs", () => {
    const previous = accepted(
      prepareSnapshot(
        fence,
        projection([
          message(1, {
            version: 3,
            updatedSequence: 10,
            body: "Accepted edit",
          }),
          message(2, {
            version: 4,
            updatedSequence: 11,
            deletedAt: 11,
            reactions: [],
            mentions: [],
            body: null,
          }),
          message(3),
        ]),
        undefined,
        true,
        100,
      ),
    );
    const incoming = projection(
      [
        message(1, { version: 2, updatedSequence: 5, body: "Old edit" }),
        message(2, { version: 2, updatedSequence: 6, body: "Deleted text" }),
        message(4),
      ],
      12,
    );
    const replaced = accepted(
      prepareSnapshot(fence, incoming, previous, true, 200),
    );
    expect(replaced.messages.map((item) => item.id)).toEqual([
      "message-1",
      "message-2",
      "message-4",
    ]);
    expect(replaced.messages[0]).toMatchObject({
      version: 3,
      body: "Accepted edit",
    });
    expect(replaced.messages[1]).toMatchObject({
      version: 4,
      deletedAt: 11,
      reactions: [],
      mentions: [],
      body: null,
      attachments: [],
    });
    const appended = accepted(
      prepareSnapshot(fence, incoming, previous, false, 200),
    );
    expect(appended.messages.map((item) => item.id)).toEqual([
      "message-1",
      "message-2",
      "message-3",
      "message-4",
    ]);
    expect(
      prepareSnapshot(fence, projection([message(1)], 9), previous, true, 300),
    ).toEqual({ kind: "stale" });
  });

  it("rejects ahead-of-replay messages, mixed channels, duplicate IDs, reordered windows and immutable-ID collisions", () => {
    const invalidWindows = [
      projection([message(1, { updatedSequence: 5 })], 4),
      projection([message(1, { channelId: id(99) })]),
      projection([message(1), message(2, { id: "message-1" })]),
      projection([message(2), message(1)], 2),
    ];
    for (const input of invalidWindows)
      expect(prepareSnapshot(fence, input, undefined, true, 100)).toEqual({
        kind: "unavailable",
        reason: "invalid-record",
      });
    const previous = accepted(
      prepareSnapshot(fence, projection([message(1)]), undefined, true, 100),
    );
    expect(
      prepareSnapshot(
        fence,
        projection([
          message(1, { authorId: id(99), version: 2, updatedSequence: 2 }),
        ]),
        previous,
        true,
        200,
      ),
    ).toEqual({ kind: "unavailable", reason: "invalid-record" });
    const mismatched = projection([message(1)]);
    mismatched.cursor.generation = id(99);
    expect(prepareSnapshot(fence, mismatched, undefined, true, 100)).toEqual({
      kind: "unavailable",
      reason: "invalid-record",
    });
  });

  it("checks UTF-8 bytes and rejects bodies beyond the server limit", () => {
    const body = "漢".repeat(Math.floor(MESSAGE_BYTE_LIMIT / 3));
    const saved = accepted(
      prepareSnapshot(
        fence,
        projection([message(1, { body })]),
        undefined,
        true,
        100,
      ),
    );
    expect(saved.byteLength).toBe(
      new TextEncoder().encode(JSON.stringify(saved)).byteLength,
    );
    expect(saved.byteLength).toBeGreaterThan(JSON.stringify(saved).length);
    expect(
      CachedSnapshotSchema.safeParse({
        ...saved,
        byteLength: saved.byteLength - 1,
      }).success,
    ).toBe(false);
    expect(
      prepareSnapshot(
        fence,
        projection([message(1, { body: `${body}漢` })]),
        undefined,
        true,
        100,
      ),
    ).toEqual({ kind: "unavailable", reason: "invalid-record" });
  });

  it("refuses extra identity, token, draft and private attachment data, including malformed tombstones", () => {
    const saved = accepted(
      prepareSnapshot(fence, projection([message(1)]), undefined, true, 100),
    );
    const forbidden = [
      { ...saved, authToken: "not-for-storage" },
      { ...saved, drafts: [{ body: "Unsent" }] },
      { ...saved, labels: { ...saved.labels, email: "private@example.test" } },
      { ...saved, fence: { ...saved.fence, role: "owner" } },
      recounted({
        ...saved,
        labels: {
          ...saved.labels,
          authors: [{ id: id(99), label: "Not a retained author" }],
        },
      }),
      recounted({
        ...saved,
        messages: [{ ...saved.messages[0]!, deletedAt: 1 }],
      }),
      {
        ...saved,
        messages: [
          {
            ...saved.messages[0]!,
            attachments: [
              {
                fileId: id(20),
                filename: "file.txt",
                byteLength: 5,
                token: "capability",
              },
            ],
          },
        ],
      },
    ];
    for (const value of forbidden)
      expect(CachedSnapshotSchema.safeParse(value).success).toBe(false);
    expect(CachedSnapshotSchema.safeParse(saved).success).toBe(true);
  });

  it("permits only invalidation identities and epochs in cross-tab messages", () => {
    const event = { type: "owner" as const, ...fence };
    expect(CacheInvalidationSchema.safeParse(event).success).toBe(true);
    for (const extra of [
      { label: "Account name" },
      { messages: [message(1)] },
      { token: "secret" },
    ])
      expect(
        CacheInvalidationSchema.safeParse({ ...event, ...extra }).success,
      ).toBe(false);
  });
});
