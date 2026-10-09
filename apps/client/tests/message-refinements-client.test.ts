import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { ApiError, NetworkError } from "@/client/api/errors";
import { SendMessageSchema, type Message } from "@vaskel/contracts/messaging";
import { invalidateMessageSearch } from "@/client/features/chat/invalidate-message-search";
import {
  applyEvents,
  latestTimeline,
  mergeMessages,
  type Timeline,
} from "@/client/features/chat/reconcile";
import { quoteKind, selectQuote } from "@/client/features/chat/quote-selection";

const owner = { kind: "server", id: "owner" } as const;
const source: Message = {
  id: "source",
  channelId: "channel",
  authorId: "author",
  body: "Captured words",
  attachments: [],
  version: 1,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  reactions: [],
  mentions: [],
  createdSequence: 1,
  updatedSequence: 1,
};
const selected = selectQuote(owner, source);
const reply: Message = {
  ...source,
  id: "reply",
  authorId: "reply-author",
  body: "Commentary",
  quote: selected.preview,
  createdSequence: 2,
  updatedSequence: 2,
};
const timeline: Timeline = latestTimeline({
  messages: [source, reply],
  nextBefore: null,
  readSequence: 0,
  cursor: {
    owner,
    channelId: "channel",
    generation: crypto.randomUUID(),
    sequence: 2,
  },
});
let isDefiniteSendRejection: typeof import("@/client/features/chat/mutation-failure").isDefiniteSendRejection;
beforeAll(async () => {
  vi.stubGlobal("window", { location: { origin: "https://vaskel.test" } });
  ({ isDefiniteSendRejection } =
    await import("@/client/features/chat/mutation-failure"));
});
afterAll(() => vi.unstubAllGlobals());

describe("captured quote behavior", () => {
  it("keeps the quote after source edits/deletion, while deleting its own message hides it permanently", () => {
    const changed = mergeMessages(timeline.messages, [
      { ...source, body: "Edited source", version: 2, updatedSequence: 3 },
    ]);
    const sourceDeleted = {
      ...source,
      body: null,
      attachments: [],
      deletedAt: 4,
      reactions: [],
      mentions: [],
      updatedAt: 4,
      version: 3,
      updatedSequence: 4,
    };
    const afterSource = applyEvents({ ...timeline, messages: changed }, [
      { operation: "delete", sequence: 4, message: sourceDeleted },
    ]);
    expect(
      afterSource.messages.find((item) => item.id === reply.id)?.quote,
    ).toEqual(selected.preview);
    const { quote: discarded, ...withoutQuote } = reply;
    expect(discarded).toBeDefined();
    const destinationDeleted = {
      ...withoutQuote,
      body: null,
      deletedAt: 5,
      reactions: [],
      mentions: [],
      updatedAt: 5,
      version: 2,
      updatedSequence: 5,
    };
    const deleted = applyEvents(afterSource, [
      { operation: "delete", sequence: 5, message: destinationDeleted },
    ]);
    expect(
      mergeMessages(deleted.messages, [reply]).find(
        (item) => item.id === reply.id,
      ),
    ).toEqual(destinationDeleted);
  });

  it("flattens a quote-only display seed but still sends the selected-message reference for authorization", () => {
    const quoteOnly = { ...reply, body: "", attachments: [] };
    const flattened = selectQuote(owner, quoteOnly);
    expect(flattened.preview).toEqual(selected.preview);
    expect(flattened.reference.messageId).toBe(reply.id);
    const command = SendMessageSchema.parse({
      commandId: "one-command",
      issuedAt: 1,
      channelId: "destination",
      body: "",
      attachmentIds: [],
      quote: flattened.reference,
    });
    expect(command.quote).toEqual(flattened.reference);
    expect(JSON.stringify(command)).not.toContain("Captured words");
    expect(selectQuote(owner, reply).preview.body).toBe("Commentary");
  });

  it("unlocks a first typed source refusal but preserves an ambiguous command through later refusals", () => {
    expect(
      isDefiniteSendRejection(new ApiError("source_unavailable"), false),
    ).toBe(true);
    expect(isDefiniteSendRejection(new NetworkError(), false)).toBe(false);
    expect(
      isDefiniteSendRejection(
        new ApiError("unavailable", 200, "contract"),
        false,
      ),
    ).toBe(false);
    expect(
      isDefiniteSendRejection(new ApiError("source_unavailable"), true),
    ).toBe(false);
    expect(isDefiniteSendRejection(new ApiError("dm_blocked"), true)).toBe(
      false,
    );
  });
});

describe("local search invalidation", () => {
  it("cancels an initial held response before a destination deletion can reinstall its quote", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const key = ["private", "account", "search", "owner"];
    let resolve!: (value: { kind: "matches"; messages: Message[] }) => void;
    const held = new Promise<{ kind: "matches"; messages: Message[] }>(
      (done) => {
        resolve = done;
      },
    );
    const queryFn = vi
      .fn()
      .mockImplementationOnce(() => held)
      .mockResolvedValue({ kind: "matches", messages: [] });
    const observer = new QueryObserver(client, { queryKey: key, queryFn });
    const unsubscribe = observer.subscribe(() => {});
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    invalidateMessageSearch(client, key, new Set([reply.id]), false);
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(2));
    resolve({ kind: "matches", messages: [reply] });
    await held;
    await vi.waitFor(() =>
      expect(client.getQueryData(key)).toEqual({
        kind: "matches",
        messages: [],
      }),
    );
    unsubscribe();
    client.clear();
  });
});

describe("quoteKind", () => {
  const here = { kind: "server", id: "circle" } as const;
  it("reads a quote of the same room as a reply", () => {
    expect(
      quoteKind(
        { owner: here, channelId: "room", messageId: "m" },
        here,
        "room",
      ),
    ).toBe("reply");
  });
  it("reads a quote from another room or place as a forward", () => {
    expect(
      quoteKind(
        { owner: here, channelId: "other", messageId: "m" },
        here,
        "room",
      ),
    ).toBe("forward");
    expect(
      quoteKind(
        {
          owner: { kind: "conversation", id: "dm" },
          channelId: "room",
          messageId: "m",
        },
        here,
        "room",
      ),
    ).toBe("forward");
  });
});
