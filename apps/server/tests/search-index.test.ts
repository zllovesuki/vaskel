import {
  messageEnvelope as command,
  acceptedMessage as accepted,
} from "@tests/helpers/messaging";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { MessagingOutcomeSchema } from "@vaskel/contracts/messaging";
import { RebuildSearchIndexOutcomeSchema } from "@vaskel/contracts/search";
import type { MessageDO } from "@/server/actors/shared/message-do";
import { openOwnerDatabase } from "@/server/actors/shared/database";
import { MESSAGE_SEARCH_POLICY } from "@/server/actors/shared/message-search";
import { mutateMessage } from "@/server/actors/shared/messages";
import { observeSql } from "@tests/helpers/sql-observer";

const principal = (userId = "alice") => ({
  userId,
  sessionId: userId,
  expiresAt: Date.now() + 60 * 60_000,
});
const operator = () => ({
  ...principal("operator"),
  isOperator: true as const,
});

async function fixture(kind: "server" | "conversation" = "server") {
  const id = crypto.randomUUID();
  let owner: DurableObjectStub<MessageDO>;
  if (kind === "server") {
    const server = env.SERVER_DO.getByName(id);
    await server.initialize({ serverId: id, name: "Search", ownerId: "alice" });
    owner = server;
  } else {
    const conversation = env.CONVERSATION_DO.getByName(id);
    await conversation.initialize({
      conversationId: id,
      participantIds: ["alice", "bob"],
    });
    owner = conversation;
  }
  return { id, owner };
}

async function matches(
  owner: DurableObjectStub<MessageDO>,
  id: string,
  query: string,
) {
  const result = MessagingOutcomeSchema.parse(
    await owner.search(principal(), { channelId: id, query }),
  );
  if (result.kind !== "matches") throw new Error(result.kind);
  return result.messages.map((message) => message.id);
}

function retainedState(storage: DurableObjectStorage) {
  const { search_policy: _policy, ...state } = storage.sql
    .exec("SELECT * FROM owner_state")
    .one();
  return {
    state,
    messages: storage.sql.exec("SELECT * FROM messages ORDER BY id").toArray(),
    events: storage.sql
      .exec("SELECT * FROM events ORDER BY sequence")
      .toArray(),
    receipts: storage.sql
      .exec("SELECT * FROM command_receipts ORDER BY command_id")
      .toArray(),
    reads: storage.sql.exec("SELECT * FROM read_cursors").toArray(),
    deleted: storage.sql.exec("SELECT * FROM deleted_payloads").toArray(),
    schema: storage.sql
      .exec("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
      .toArray(),
  };
}

it.each(["server", "conversation"] as const)(
  "repairs a %s index from live text and quotes while preserving data and subsequent writes",
  async (kind) => {
    const { id, owner } = await fixture(kind);
    const source = accepted(
      (
        await owner.send(principal(), {
          ...command(id),
          body: "Original orchard",
        })
      ).outcome,
    );
    const quote = accepted(
      (
        await owner.send(principal(), {
          ...command(id),
          body: "",
          quote: {
            owner: { kind, id },
            channelId: id,
            messageId: source.messageId,
          },
        })
      ).outcome,
    );
    accepted(
      await owner.edit(principal(), {
        ...command(id),
        messageId: source.messageId,
        expectedVersion: 1,
        body: "Replacement cedar",
      }),
    );
    accepted(
      await owner.deleteMessage(principal(), {
        ...command(id),
        messageId: source.messageId,
        expectedVersion: 2,
      }),
    );
    expect(await matches(owner, id, "orchard")).toEqual([quote.messageId]);
    expect(await matches(owner, id, "cedar")).toEqual([]);

    const before = await runInDurableObject(owner, async (_instance, state) => {
      const database = openOwnerDatabase(state.storage);
      // More than two index batches, with actual command/sequence allocation.
      for (let index = 0; index < 65; index++) {
        const result = await mutateMessage(
          state.storage,
          database,
          principal(),
          {
            kind: "send",
            command: { ...command(id), body: `Batch pine ${index}` },
          },
          Number.MAX_SAFE_INTEGER,
        );
        expect(result.kind).toBe("committed");
      }
      state.storage.sql.exec(
        "INSERT INTO read_cursors(user_id,channel_id,sequence) VALUES ('alice',?,2)",
        id,
      );
      // Rebuild also repairs missing and stale derived records.
      state.storage.sql.exec(
        "DELETE FROM message_fts WHERE message_id=?",
        quote.messageId,
      );
      state.storage.sql.exec(
        "INSERT INTO message_fts(rowid,message_id,body) VALUES (999999,'orphan','Ghosttoken')",
      );
      state.storage.sql.exec(
        "UPDATE message_fts SET message_id=message_id,body='Staletoken' WHERE rowid=(SELECT MIN(rowid) FROM message_fts)",
      );
      return retainedState(state.storage);
    });
    expect(await matches(owner, id, "orchard")).toEqual([]);
    expect(
      RebuildSearchIndexOutcomeSchema.parse(
        await owner.rebuildSearchIndex(operator()),
      ),
    ).toEqual({ kind: "search_index_rebuilt", indexedMessages: 66 });
    await runInDurableObject(owner, (_instance, state) => {
      expect(retainedState(state.storage)).toEqual(before);
      expect(
        state.storage.sql.exec("SELECT search_policy FROM owner_state").one()
          .search_policy,
      ).toBe(MESSAGE_SEARCH_POLICY);
      const indexed = state.storage.sql
        .exec(
          "SELECT message_fts.rowid AS rowid,messages.created_sequence FROM message_fts LEFT JOIN messages ON messages.id=message_fts.message_id",
        )
        .toArray();
      expect(indexed).toHaveLength(66);
      expect(indexed.every((row) => row.rowid === row.created_sequence)).toBe(
        true,
      );
    });
    expect(await matches(owner, id, "orchard")).toEqual([quote.messageId]);
    expect(await matches(owner, id, "cedar")).toEqual([]);
    expect(await matches(owner, id, "Staletoken")).toEqual([]);
    expect(
      await owner.search(operator(), { channelId: id, query: "orchard" }),
    ).toEqual({ kind: "forbidden" });

    await evictDurableObject(owner);
    const [, sent] = await Promise.all([
      owner.rebuildSearchIndex(operator()),
      owner
        .send(principal(), { ...command(id), body: "Concurrent maple" })
        .then(({ outcome }) => outcome),
    ]);
    expect(await matches(owner, id, "maple")).toEqual([
      accepted(sent).messageId,
    ]);
    accepted(
      await owner.edit(principal(), {
        ...command(id),
        messageId: quote.messageId,
        expectedVersion: 1,
        body: "Added birch",
      }),
    );
    expect(await matches(owner, id, "orchard")).toEqual([quote.messageId]);
    expect(await matches(owner, id, "birch")).toEqual([quote.messageId]);
    accepted(
      await owner.deleteMessage(principal(), {
        ...command(id),
        messageId: quote.messageId,
        expectedVersion: 2,
      }),
    );
    expect(await matches(owner, id, "orchard")).toEqual([]);
    expect(await owner.rebuildSearchIndex(operator())).toEqual({
      kind: "search_index_rebuilt",
      indexedMessages: 66,
    });
  },
);

it("requires current operator authority and supports empty or missing owners", async () => {
  const { owner } = await fixture();
  expect(
    await owner.rebuildSearchIndex(principal() as ReturnType<typeof operator>),
  ).toEqual({ kind: "forbidden" });
  expect(
    await owner.rebuildSearchIndex({ ...operator(), expiresAt: 0 }),
  ).toEqual({ kind: "unauthenticated" });
  expect(await owner.rebuildSearchIndex(operator())).toEqual({
    kind: "search_index_rebuilt",
    indexedMessages: 0,
  });
  expect(
    await env.SERVER_DO.getByName(crypto.randomUUID()).rebuildSearchIndex(
      operator(),
    ),
  ).toEqual({ kind: "not_found" });
});

it("rolls back cleared and repopulated FTS contents and the format marker on native failure", async () => {
  const { id, owner } = await fixture();
  const receipt = accepted(
    (
      await owner.send(principal(), {
        ...command(id),
        body: "Preserved willow",
      })
    ).outcome,
  );
  const before = await runInDurableObject(owner, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE owner_state SET search_policy='damaged-index'",
    );
    state.storage.sql.exec(
      "UPDATE message_fts SET rowid=500, message_id=?, body='Oldindex willow' WHERE message_id=?",
      receipt.messageId,
      receipt.messageId,
    );
    state.storage.sql.exec(
      "CREATE TRIGGER reject_rebuild BEFORE UPDATE OF search_policy ON owner_state BEGIN SELECT RAISE(ABORT, 'injected rebuild failure'); END",
    );
    return retainedState(state.storage);
  });
  await expect(
    (async () => await owner.rebuildSearchIndex(operator()))(),
  ).rejects.toThrow(/injected rebuild failure/);
  await runInDurableObject(owner, (_instance, state) => {
    // A deliberately corrupt rowid is not a supported ordinary search format.
    expect(
      state.storage.sql
        .exec(
          "SELECT rowid,message_id FROM message_fts WHERE message_fts MATCH 'Oldindex'",
        )
        .toArray(),
    ).toEqual([{ rowid: 500, message_id: receipt.messageId }]);
    expect(
      state.storage.sql
        .exec(
          "SELECT rowid FROM message_fts WHERE message_fts MATCH 'Preserved'",
        )
        .toArray(),
    ).toEqual([]);
    expect(retainedState(state.storage)).toEqual(before);
    expect(
      state.storage.sql.exec("SELECT search_policy FROM owner_state").one()
        .search_policy,
    ).toBe("damaged-index");
    expect(
      state.storage.sql.exec("SELECT rowid FROM message_fts").one().rowid,
    ).toBe(500);
    state.storage.sql.exec("DROP TRIGGER reject_rebuild");
  });
  expect(await owner.rebuildSearchIndex(operator())).toEqual({
    kind: "search_index_rebuilt",
    indexedMessages: 1,
  });
  expect(await matches(owner, id, "Preserved")).toEqual([receipt.messageId]);
  expect(await matches(owner, id, "Oldindex")).toEqual([]);
});

it("keeps FTS edit and delete lookup work bounded as fresh-owner history grows", async () => {
  const measurements = [];
  for (const size of [100, 10_000]) {
    const { id, owner } = await fixture();
    await runInDurableObject(owner, (_instance, state) => {
      state.storage.sql.exec(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<?) INSERT INTO messages(id,channel_id,author_id,body,version,created_sequence,updated_sequence,created_at,updated_at,deleted_at,quote_json) SELECT printf('msg-%06d',x),?,'alice','Original walnut',1,x*2,x*2,x,x,NULL,NULL FROM n",
        size,
        id,
      );
      state.storage.sql.exec("UPDATE owner_state SET high_water=?", size * 2);
      state.storage.sql.exec(
        "INSERT INTO message_fts(rowid,message_id,body) SELECT created_sequence,id,body FROM messages",
      );
    });
    const observed = await runInDurableObject(
      owner,
      async (_instance, state) => {
        const database = openOwnerDatabase(state.storage);
        return observeSql(state.storage.sql, async () => {
          for (const kind of ["edit", "delete"] as const) {
            const fields = {
              ...command(id),
              messageId: "msg-000001",
              expectedVersion: kind === "edit" ? 1 : 2,
            };
            const result = await mutateMessage(
              state.storage,
              database,
              principal(),
              kind === "edit"
                ? { kind, command: { ...fields, body: "Updated walnut" } }
                : { kind, command: fields },
              Number.MAX_SAFE_INTEGER,
            );
            expect(result.kind).toBe("committed");
          }
        });
      },
    );
    const deletes = observed.statements.filter(({ query }) =>
      /^DELETE FROM message_fts/.test(query),
    );
    expect(deletes).toHaveLength(2);
    for (const statement of deletes) {
      expect(statement.rowsRead).toBeLessThanOrEqual(2);
      expect(statement.rowsWritten).toBe(1);
    }
    expect(await matches(owner, id, "Updated")).toEqual([]);
    measurements.push({
      size,
      rowsRead: deletes.map((statement) => statement.rowsRead),
    });
  }
  console.log(
    "Native FTS edit/delete lookup rows",
    JSON.stringify(measurements),
  );
});
