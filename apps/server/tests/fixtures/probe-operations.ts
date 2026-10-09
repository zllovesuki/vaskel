import { sql, type Kysely } from "kysely";
import type {
  FailureStage,
  ProbeCommand,
  ProbeDatabase,
  ProbeOutcome,
} from "@tests/fixtures/probe-schema";

interface ProbeOptions {
  failAfter?: FailureStage;
  /** An in-process test barrier; never available on a production or RPC contract. */
  afterMessageWrite?: () => Promise<void>;
}

export async function appendProbeMessage(
  storage: DurableObjectStorage,
  database: Kysely<ProbeDatabase>,
  command: ProbeCommand,
  options: ProbeOptions = {},
): Promise<ProbeOutcome> {
  return await storage.transaction(async () => {
    const previous = await database
      .selectFrom("command_receipts")
      .selectAll()
      .where("actor_id", "=", command.actorId)
      .where("operation", "=", "send")
      .where("command_id", "=", command.commandId)
      .executeTakeFirst();
    if (previous) {
      return previous.payload === command.body
        ? {
            kind: "accepted",
            receipt: {
              messageId: previous.message_id,
              sequence: previous.sequence,
            },
          }
        : { kind: "command_conflict" };
    }

    const owner = await database
      .selectFrom("owner_state")
      .select("high_water")
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    const sequence = owner.high_water + 1;
    const messageId = crypto.randomUUID();
    const message = {
      id: messageId,
      author_id: command.actorId,
      body: command.body,
      sequence,
    };

    // A real constraint violation after each selected write tests adapter rejection/rollback.
    async function failAt(stage: FailureStage) {
      if (options.failAfter === stage) {
        await database.insertInto("messages").values(message).execute();
      }
    }

    await database.insertInto("messages").values(message).execute();
    await options.afterMessageWrite?.();
    await failAt("message");
    await database
      .updateTable("owner_state")
      .set({ high_water: sequence })
      .where("id", "=", 1)
      .execute();
    await sql`INSERT INTO message_fts (message_id, body) VALUES (${messageId}, ${command.body})`.execute(
      database,
    );
    await failAt("fts");
    await database
      .insertInto("events")
      .values({ sequence, message_id: messageId })
      .execute();
    await failAt("event");
    await database
      .insertInto("command_receipts")
      .values({
        actor_id: command.actorId,
        operation: "send",
        command_id: command.commandId,
        payload: command.body,
        message_id: messageId,
        sequence,
      })
      .execute();
    await failAt("receipt");

    return { kind: "accepted", receipt: { messageId, sequence } };
  });
}

export function snapshotProbe(
  storage: DurableObjectStorage,
  database: Kysely<ProbeDatabase>,
) {
  return storage.transaction(async () => {
    const owner = await database
      .selectFrom("owner_state")
      .selectAll()
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    const messages = await database
      .selectFrom("messages")
      .selectAll()
      .orderBy("sequence")
      .execute();
    const events = await database
      .selectFrom("events")
      .selectAll()
      .orderBy("sequence")
      .execute();
    const receipts = await database
      .selectFrom("command_receipts")
      .selectAll()
      .orderBy("sequence")
      .execute();
    // Contentless FTS stores only the UNINDEXED key; bodies are matchable, not readable.
    const fts = await sql<{ message_id: string }>`
      SELECT message_id FROM message_fts ORDER BY rowid
    `.execute(database);
    return {
      highWater: owner.high_water,
      searchPolicy: owner.search_policy,
      messages,
      events,
      receipts,
      fts: fts.rows.map((row) => row.message_id),
    };
  });
}

/** Mirrors the production delete: the canonical row and receipt stay, the search document goes. */
export async function removeProbeMessage(
  storage: DurableObjectStorage,
  database: Kysely<ProbeDatabase>,
  messageId: string,
  options: { fail?: boolean } = {},
): Promise<number> {
  return await storage.transaction(async () => {
    const owner = await database
      .selectFrom("owner_state")
      .select("high_water")
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    const sequence = owner.high_water + 1;
    const event = { sequence, message_id: messageId };
    await database
      .updateTable("owner_state")
      .set({ high_water: sequence })
      .where("id", "=", 1)
      .execute();
    await database.insertInto("events").values(event).execute();
    await sql`DELETE FROM message_fts WHERE message_id = ${messageId}`.execute(
      database,
    );
    // A real constraint violation after the contentless delete tests its rollback.
    if (options.fail)
      await database.insertInto("events").values(event).execute();
    return sequence;
  });
}

export type ProbeSearchOutcome =
  | { kind: "query_too_short"; minimum: 3 }
  | { kind: "matches"; messageIds: string[] };

export async function searchProbe(
  database: Kysely<ProbeDatabase>,
  input: string,
): Promise<ProbeSearchOutcome> {
  const query = input.trim();
  if (Array.from(query).length < 3) {
    return { kind: "query_too_short", minimum: 3 };
  }
  // Native literal trigram phrase: FTS operators and quote characters stay data.
  const literal = `"${query.replaceAll('"', '""')}"`;
  const result = await sql<{ message_id: string }>`
    SELECT message_id FROM message_fts WHERE message_fts MATCH ${literal} ORDER BY rowid LIMIT 50
  `.execute(database);
  return {
    kind: "matches",
    messageIds: result.rows.map((row) => row.message_id),
  };
}
