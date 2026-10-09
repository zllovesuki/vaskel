import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import {
  MessageSchema,
  QuoteSnapshotSchema,
  type QuoteSnapshot,
} from "@vaskel/contracts/messaging";
import {
  openOwnerDatabase,
  type MessageRow,
} from "@/server/actors/shared/database";
import { materializeMessages } from "@/server/actors/shared/message-materialization";
import { observeSql, selectStatements } from "@tests/helpers/sql-observer";

it("batches current details across chunk boundaries without changing replay order or tombstone masking", async () => {
  const id = crypto.randomUUID();
  const owner = env.SERVER_DO.getByName(id);
  await owner.initialize({ serverId: id, name: "Details", ownerId: "alice" });
  await runInDurableObject(owner, async (instance, state) => {
    const database = openOwnerDatabase(state.storage);
    const principal = (userId: string) => ({
      userId,
      sessionId: userId,
      expiresAt: Date.now() + 60_000,
    });
    const initial = await instance.snapshot(principal("alice"), {
      channelId: id,
    });
    if (initial.kind !== "snapshot") throw new Error(initial.kind);
    const quote: QuoteSnapshot = {
      source: {
        owner: initial.cursor.owner,
        channelId: id,
        messageId: "captured-original",
      },
      authorId: "bob",
      body: "Captured quote",
      createdAt: 1,
      version: 2,
      attachmentCount: 1,
    };
    const rows: MessageRow[] = Array.from({ length: 53 }, (_, index) => ({
      id: crypto.randomUUID(),
      channel_id: id,
      author_id: "alice",
      body: `Hydration ${index}`,
      version: index === 0 ? 3 : 1,
      created_sequence: index + 1,
      updated_sequence: index === 0 ? 101 : index + 1,
      created_at: index + 1,
      updated_at: index === 0 ? 101 : index + 1,
      deleted_at: index === 52 ? 100 : null,
      quote_json: JSON.stringify(quote),
    }));
    const files = new Map<string, string[]>();
    await state.storage.transaction(async () => {
      await database
        .insertInto("members")
        .values({ user_id: "bob", role: "member" })
        .execute();
      for (const row of rows) {
        await database.insertInto("messages").values(row).execute();
        if (row.deleted_at === null)
          state.storage.sql.exec(
            "INSERT INTO message_fts(rowid,message_id,body) VALUES (?,?,?)",
            row.created_sequence,
            row.id,
            row.body,
          );
      }
      for (const row of [rows[0]!, rows[50]!, rows[52]!]) {
        const fileIds = Array.from({ length: 4 }, () => crypto.randomUUID());
        files.set(row.id, fileIds);
        for (const ordinal of [2, 0, 1, 3]) {
          await database
            .insertInto("attachments")
            .values({
              id: fileIds[ordinal]!,
              channel_id: id,
              uploader_id: "alice",
              command_id: fileIds[ordinal]!,
              payload_hash: "fixture",
              issued_at: 1,
              created_at: 1,
              reservation_expires_at: 10,
              filename: ordinal === 0 ? '["file"]' : `${ordinal}.txt`,
              byte_length: 1,
              object_key: null,
              owner_generation: initial.cursor.generation,
              state: ordinal === 3 ? "retired" : "claimed",
              writer_state: "settled",
              outstanding: 0,
              deadline: null,
              message_id: row.id,
              ordinal,
              quarantined: ordinal === 1 ? 1 : 0,
            })
            .execute();
        }
        for (const [user_id, emoji] of [
          ["bob", "👍"],
          ["alice", "👍"],
          ["bob", "🎉"],
        ])
          await database
            .insertInto("reactions")
            .values({
              message_id: row.id,
              user_id: user_id!,
              emoji: emoji!,
              created_at: 1,
            })
            .execute();
        for (const user_id of ["bob", "alice", '{"name":"literal"}'])
          await database
            .insertInto("mentions")
            .values({
              message_id: row.id,
              user_id,
              channel_id: id,
              created_sequence: row.created_sequence,
            })
            .execute();
      }
      for (let sequence = 1; sequence <= 101; sequence++) {
        await database
          .insertInto("events")
          .values({
            sequence,
            previous_sequence: sequence - 1,
            channel_id: id,
            operation: sequence <= rows.length ? "send" : "edit",
            message_id:
              sequence <= rows.length ? rows[sequence - 1]!.id : rows[0]!.id,
          })
          .execute();
      }
      await database
        .updateTable("owner_state")
        .set({ high_water: 101 })
        .where("id", "=", 1)
        .execute();
    });

    for (const [length, selects] of [
      [0, 0],
      [50, 1],
      [51, 2],
    ] as const) {
      const observed = await observeSql(state.storage.sql, () =>
        state.storage.transaction(() =>
          materializeMessages(database, rows.slice(0, length), "alice"),
        ),
      );
      expect(selectStatements(observed.statements)).toHaveLength(selects);
      expect(
        observed.statements.every(({ bindings }) => bindings.length <= 100),
      ).toBe(true);
      expect(observed.value.map((message) => message.id)).toEqual(
        rows.slice(0, length).map((row) => row.id),
      );
    }
    const tombstone = await observeSql(state.storage.sql, () =>
      state.storage.transaction(() =>
        materializeMessages(database, [rows[52]!], "alice"),
      ),
    );
    expect(tombstone.statements).toEqual([]);
    expect(tombstone.value[0]).toMatchObject({
      body: null,
      attachments: [],
      reactions: [],
      mentions: [],
      deletedAt: 100,
    });
    expect(tombstone.value[0]).not.toHaveProperty("quote");
    for (const reader of ["alice", "bob"]) {
      const parseQuote = vi.spyOn(QuoteSnapshotSchema, "parse");
      const observed = await observeSql(state.storage.sql, async () => {
        const result = await instance.replay(principal(reader), {
          channelId: id,
          cursor: initial.cursor,
        });
        // The page has 52 distinct live messages, one tombstone and 47 repeats.
        expect(parseQuote).toHaveBeenCalledTimes(52);
        return result;
      }).finally(() => parseQuote.mockRestore());
      const replay = observed.value;
      if (replay.kind !== "replay") throw new Error(replay.kind);
      expect(selectStatements(observed.statements)).toHaveLength(6);
      expect(replay).toMatchObject({
        cursor: { sequence: 100 },
        hasMore: true,
        highWater: 101,
      });
      expect(replay.events.map((event) => event.sequence)).toEqual(
        Array.from({ length: 100 }, (_, index) => index + 1),
      );
      expect(replay.events[53]!.message).toEqual(replay.events[0]!.message);
      expect(replay.events[52]!.message).toEqual(tombstone.value[0]);
      for (const index of [0, 50, 53, 99]) {
        const message = MessageSchema.parse(replay.events[index]!.message);
        expect(message).toMatchObject({
          quote,
          attachments: [0, 2].map((ordinal) => ({
            fileId: files.get(message.id)![ordinal],
            filename: ordinal === 0 ? '["file"]' : `${ordinal}.txt`,
            byteLength: 1,
          })),
          reactions: [
            { emoji: "🎉", count: 1, mine: reader === "bob" },
            { emoji: "👍", count: 2, mine: true },
          ],
          mentions: ["alice", "bob", '{"name":"literal"}'],
        });
      }
      const rest = await observeSql(state.storage.sql, () =>
        instance.replay(principal(reader), {
          channelId: id,
          cursor: replay.cursor,
        }),
      );
      expect(rest.value).toMatchObject({
        kind: "replay",
        events: [{ sequence: 101, message: replay.events[0]!.message }],
        cursor: { sequence: 101 },
        hasMore: false,
      });
      expect(selectStatements(rest.statements)).toHaveLength(5);
    }
    const around = await observeSql(state.storage.sql, () =>
      instance.around(principal("bob"), { channelId: id, sequence: 1 }),
    );
    expect(around.value).toMatchObject({
      kind: "around",
      messages: [
        { id: rows[0]!.id },
        ...rows.slice(1, 40).map((row) => ({ id: row.id })),
      ],
    });
    expect(selectStatements(around.statements)).toHaveLength(6);
    const search = await observeSql(state.storage.sql, () =>
      instance.search(principal("bob"), { channelId: id, query: "Hydration" }),
    );
    expect(search.value).toMatchObject({
      kind: "matches",
      messages: rows
        .slice(12, 52)
        .reverse()
        .map((row) => ({ id: row.id })),
    });
    // Authorization, live-room bounds, FTS and one batched detail read.
    expect(selectStatements(search.statements).length).toBeLessThanOrEqual(6);

    const candidates = await instance.searchCandidates(principal("bob"), {
      query: "Hydration",
      limit: 40,
    });
    if (candidates.kind !== "search_candidates")
      throw new Error(candidates.kind);
    const selection = {
      candidates: candidates.candidates.slice(0, 40).reverse(),
    };
    const selected = await observeSql(state.storage.sql, () =>
      instance.materializeSearch(principal("bob"), selection),
    );
    expect(selected.value).toMatchObject({
      kind: "search_materialized",
      hits: selection.candidates.map((candidate) => ({
        message: { id: candidate.messageId },
      })),
    });
    expect(selectStatements(selected.statements)).toHaveLength(4);
    const changed = await observeSql(state.storage.sql, () =>
      instance.materializeSearch(principal("bob"), {
        ...selection,
        candidates: selection.candidates.map((candidate, index) =>
          index === 39
            ? { ...candidate, version: candidate.version + 1 }
            : candidate,
        ),
      }),
    );
    expect(changed.value).toMatchObject({
      kind: "search_materialized",
      hits: selection.candidates
        .slice(0, 39)
        .map((candidate) => ({ message: { id: candidate.messageId } })),
    });
    // Enrichment remains batched for the surviving current selections.
    expect(selectStatements(changed.statements)).toHaveLength(4);
  });
});
