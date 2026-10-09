import { sql, type Kysely } from "kysely";
import type { RebuildSearchIndexOutcome } from "@vaskel/contracts/search";
import type { Principal } from "@/server/domain/principal";
import type { MessageRow, OwnerDatabase } from "./database";
import { MESSAGE_SEARCH_POLICY, messageSearchBody } from "./message-search";
import { getState, principalFailure } from "./policy";

// Three parameters per document stay below the native 100-parameter limit.
const INDEX_BATCH_SIZE = 32;
type SearchDocument = Pick<
  MessageRow,
  "id" | "created_sequence" | "body" | "quote_json"
>;

/** Caller owns the native transaction; FTS rowids are immutable creation sequences. */
export async function indexSearchMessages(
  database: Kysely<OwnerDatabase>,
  rows: readonly SearchDocument[],
) {
  for (let offset = 0; offset < rows.length; offset += INDEX_BATCH_SIZE) {
    const values = rows
      .slice(offset, offset + INDEX_BATCH_SIZE)
      .map(
        (row) =>
          sql`(${row.created_sequence}, ${row.id}, ${messageSearchBody(row)})`,
      );
    await sql`INSERT INTO message_fts (rowid, message_id, body)
      VALUES ${sql.join(values)}`.execute(database);
  }
}

export async function removeSearchMessage(
  database: Kysely<OwnerDatabase>,
  row: Pick<MessageRow, "created_sequence">,
) {
  await sql`DELETE FROM message_fts WHERE rowid = ${row.created_sequence}`.execute(
    database,
  );
}

/** Explicit maintenance; a failure restores both the old index and its format. */
export function rebuildSearchIndex(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  principal: Principal & { isOperator: true },
): Promise<RebuildSearchIndexOutcome> {
  return storage.transaction(async () => {
    const invalid = principalFailure(principal);
    if (invalid) return invalid;
    if (principal.isOperator !== true) return { kind: "forbidden" };
    if (!(await getState(database))) return { kind: "not_found" };

    await sql`INSERT INTO message_fts (message_fts) VALUES ('delete-all')`.execute(
      database,
    );
    let after: string | undefined;
    let indexedMessages = 0;
    while (true) {
      let query = database
        .selectFrom("messages")
        .select(["id", "created_sequence", "body", "quote_json"])
        .where("deleted_at", "is", null)
        .orderBy("id")
        .limit(INDEX_BATCH_SIZE);
      if (after !== undefined) query = query.where("id", ">", after);
      const rows = await query.execute();
      await indexSearchMessages(database, rows);
      indexedMessages += rows.length;
      if (rows.length < INDEX_BATCH_SIZE) break;
      after = rows.at(-1)!.id;
    }
    await database
      .updateTable("owner_state")
      .set({ search_policy: MESSAGE_SEARCH_POLICY })
      .where("id", "=", 1)
      .execute();
    return { kind: "search_index_rebuilt", indexedMessages };
  });
}
