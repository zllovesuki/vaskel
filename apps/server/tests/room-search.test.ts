import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { MessageDO } from "@/server/actors/shared/message-do";
import { alice } from "@tests/helpers/messaging-owner";
import { observeSql } from "@tests/helpers/sql-observer";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import { searchMessages } from "@/server/actors/shared/synchronization";

it.each(["server", "conversation"] as const)(
  "uses creation positions for %s room search with ordered, scoped limits",
  async (kind) => {
    const id = crypto.randomUUID();
    const other = crypto.randomUUID();
    let owner: DurableObjectStub<MessageDO>;
    if (kind === "server") {
      const server = env.SERVER_DO.getByName(id);
      await server.initialize({
        serverId: id,
        name: "Search",
        ownerId: "alice",
      });
      owner = server;
    } else {
      const conversation = env.CONVERSATION_DO.getByName(id);
      await conversation.initialize({
        conversationId: id,
        participantIds: ["alice", "bob"],
      });
      owner = conversation;
    }
    await runInDurableObject(owner, (_instance, state) => {
      if (kind === "server")
        state.storage.sql.exec(
          "INSERT INTO channels(id,name,private,version) VALUES (?,'Other room',0,1)",
          other,
        );
      // Physical rowids differ from creation positions. Interleaved hits in
      // other rooms must not consume the requested room's result limit.
      state.storage.sql.exec(
        `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<120)
        INSERT INTO messages(id,channel_id,author_id,body,version,created_sequence,updated_sequence,created_at,updated_at,deleted_at,quote_json)
        SELECT printf('message-%03d',x),CASE WHEN x%6=0 THEN ? ELSE ? END,'alice',
          'common orchard' || CASE WHEN x=6 THEN ' rare cedar' ELSE '' END,
          1,x*3,x*3,x,x,NULL,NULL FROM n`,
        id,
        kind === "server" ? other : id,
      );
      state.storage.sql.exec(
        "INSERT INTO message_fts(rowid,message_id,body) SELECT created_sequence,id,body FROM messages",
      );
      state.storage.sql.exec("UPDATE owner_state SET high_water=360");
    });
    for (const [query, limit, positions] of [
      [
        "common",
        4,
        kind === "server" ? [120, 114, 108, 102] : [120, 119, 118, 117],
      ],
      ["rare cedar", 40, [6]],
      ["absentneedle", 40, []],
    ] as const) {
      expect(
        await owner.search(alice(), { channelId: id, query, limit }),
      ).toMatchObject({
        kind: "matches",
        messages: positions.map((position) => ({
          id: `message-${String(position).padStart(3, "0")}`,
          channelId: id,
          createdSequence: position * 3,
        })),
      });
    }
  },
);

it("stops common-term FTS traversal after the requested room results", async () => {
  for (const size of [100, 10_000]) {
    const id = crypto.randomUUID();
    const owner = env.SERVER_DO.getByName(id);
    await owner.initialize({ serverId: id, name: "Search", ownerId: "alice" });
    const observed = await runInDurableObject(
      owner,
      async (_instance, state) => {
        state.storage.sql.exec(
          `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?)
        INSERT INTO messages(id,channel_id,author_id,body,version,created_sequence,updated_sequence,created_at,updated_at,deleted_at,quote_json)
        SELECT printf('message-%06d',x),?,'alice','common orchard',1,x*3,x*3,x,x,NULL,NULL FROM n`,
          size,
          id,
        );
        state.storage.sql.exec(
          "INSERT INTO message_fts(rowid,message_id,body) SELECT created_sequence,id,body FROM messages",
        );
        state.storage.sql.exec("UPDATE owner_state SET high_water=?", size * 3);
        return observeSql(state.storage.sql, () =>
          searchMessages(
            state.storage,
            openOwnerDatabase(state.storage),
            alice(),
            {
              channelId: id,
              query: "common",
              limit: 40,
            },
          ),
        );
      },
    );
    expect(observed.value).toMatchObject({
      kind: "matches",
      messages: Array.from({ length: 40 }, (_, index) => ({
        createdSequence: (size - index) * 3,
      })),
    });
    const search = observed.statements.filter(({ query }) =>
      query.includes("message_fts MATCH"),
    );
    expect(search).toHaveLength(1);
    expect(search[0]!.rowsRead).toBeLessThanOrEqual(128);
    expect(
      observed.statements.every(({ rowsWritten }) => rowsWritten === 0),
    ).toBe(true);
  }
});

it("skips FTS when the requested room has no live messages", async () => {
  const id = crypto.randomUUID();
  const owner = env.SERVER_DO.getByName(id);
  await owner.initialize({ serverId: id, name: "Search", ownerId: "alice" });
  const observed = await runInDurableObject(owner, async (_instance, state) => {
    state.storage.sql.exec(
      "INSERT INTO channels(id,name,private,version) VALUES ('other','Other',0,1)",
    );
    state.storage.sql.exec(
      `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO messages(id,channel_id,author_id,body,version,created_sequence,updated_sequence,created_at,updated_at,deleted_at,quote_json)
      SELECT printf('deleted-%05d',x),?,'alice',NULL,2,x,x+10000,x,x+10000,x+10000,NULL FROM n`,
      id,
    );
    state.storage.sql.exec(
      `INSERT INTO messages(id,channel_id,author_id,body,version,created_sequence,updated_sequence,created_at,updated_at,deleted_at,quote_json)
      VALUES ('live','other','alice','common orchard',1,20001,20001,20001,20001,NULL,NULL)`,
    );
    state.storage.sql.exec(
      "INSERT INTO message_fts(rowid,message_id,body) VALUES (20001,'live','common orchard')",
    );
    state.storage.sql.exec("UPDATE owner_state SET high_water=20001");
    return observeSql(state.storage.sql, () =>
      searchMessages(state.storage, openOwnerDatabase(state.storage), alice(), {
        channelId: id,
        query: "common",
      }),
    );
  });
  expect(observed.value).toEqual({ kind: "matches", messages: [] });
  const range = observed.statements.find(({ query }) =>
    query.includes("AS oldest"),
  );
  expect(range?.rowsRead).toBeLessThanOrEqual(2);
  expect(
    observed.statements.some(({ query }) => query.includes("message_fts")),
  ).toBe(false);
  expect(
    observed.statements.every(({ rowsWritten }) => rowsWritten === 0),
  ).toBe(true);
});
