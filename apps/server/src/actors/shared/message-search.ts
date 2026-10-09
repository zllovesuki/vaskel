import { QuoteSnapshotSchema } from "@vaskel/contracts/messaging";
import { CROSS_SEARCH_QUERY_MIN_CODE_POINTS } from "@vaskel/contracts/search";

/** FTS rowids use immutable owner-wide creation sequences. */
export const MESSAGE_SEARCH_POLICY = "native-trigram-sequence-v1";

/**
 * One search document definition for the contentless trigram index: `message_fts`
 * keeps message IDs and no text, so it is repopulated only by re-indexing canonical
 * `messages` rows through this body inside the message transaction; nothing rebuilds
 * it on restore.
 */
export function messageSearchBody(row: {
  body: string | null;
  quote_json: string | null;
}): string {
  const quote =
    row.quote_json === null
      ? null
      : QuoteSnapshotSchema.parse(JSON.parse(row.quote_json));
  return [row.body ?? "", quote?.body ?? ""]
    .filter((part) => part.length > 0)
    .join("\n");
}
/**
 * The query grammar versions with the indexed body above: one literal quoted
 * FTS5 phrase, or null when the trimmed query is below the shared minimum.
 */
export function ftsPhrase(query: string): string | null {
  const trimmed = query.trim();
  return Array.from(trimmed).length < CROSS_SEARCH_QUERY_MIN_CODE_POINTS
    ? null
    : `"${trimmed.replaceAll('"', '""')}"`;
}
