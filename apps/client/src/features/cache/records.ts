import { MESSAGE_BYTE_LIMIT, type Message } from "@vaskel/contracts/messaging";
import {
  CachedSnapshotSchema,
  HISTORY_BYTE_LIMIT,
  HISTORY_FORMAT,
  HISTORY_MESSAGE_LIMIT,
  sameOwner,
  snapshotByteLength,
  type CachedSnapshot,
  type CacheResult,
  type HistoryFence,
  type HistoryProjection,
} from "./model";

const invalid = (): CacheResult<never> => ({
  kind: "unavailable",
  reason: "invalid-record",
});

function retainVersion(previous: Message, incoming: Message): Message {
  if (previous.deletedAt !== null && incoming.deletedAt === null)
    return previous;
  if (incoming.deletedAt !== null && previous.deletedAt === null)
    return incoming;
  return previous.version > incoming.version ||
    (previous.version === incoming.version &&
      previous.updatedSequence > incoming.updatedSequence)
    ? previous
    : incoming;
}

/** The only persisted representation of an accepted, contiguous online window. */
export function prepareSnapshot(
  fence: HistoryFence,
  projection: HistoryProjection,
  previous: CachedSnapshot | undefined,
  replace: boolean,
  savedAt: number,
): CacheResult<CachedSnapshot> {
  const { cursor } = projection;
  if (
    !sameOwner(fence.owner, cursor.owner) ||
    fence.generation !== cursor.generation
  )
    return invalid();
  if (previous && previous.cursor.sequence > cursor.sequence)
    return { kind: "stale" };

  const incomingIds = new Set<string>();
  let lastSequence = 0;
  for (const message of projection.messages) {
    if (
      incomingIds.has(message.id) ||
      message.channelId !== cursor.channelId ||
      message.createdSequence <= lastSequence ||
      message.updatedSequence < message.createdSequence ||
      message.updatedSequence > cursor.sequence ||
      (message.body !== null &&
        new TextEncoder().encode(message.body).byteLength > MESSAGE_BYTE_LIMIT)
    )
      return invalid();
    incomingIds.add(message.id);
    lastSequence = message.createdSequence;
  }
  const existing = new Map(
    previous?.messages.map((message) => [message.id, message]),
  );
  const byId = replace ? new Map<string, Message>() : new Map(existing);
  for (const message of projection.messages) {
    const older = existing.get(message.id);
    if (
      older &&
      (older.authorId !== message.authorId ||
        older.createdSequence !== message.createdSequence ||
        older.createdAt !== message.createdAt)
    )
      return invalid();
    byId.set(message.id, older ? retainVersion(older, message) : message);
  }
  const ordered = [...byId.values()].sort(
    (a, b) => a.createdSequence - b.createdSequence,
  );
  const messages = ordered.slice(-HISTORY_MESSAGE_LIMIT);
  const authorLabels = new Map(
    previous?.labels.authors.map((author) => [author.id, author]),
  );
  for (const author of projection.labels.authors)
    authorLabels.set(author.id, author);
  const snapshot: CachedSnapshot = {
    ...projection,
    format: HISTORY_FORMAT,
    fence,
    messages,
    nextBefore: projection.nextBefore,
    savedAt,
    byteLength: 0,
    labels: { ...projection.labels, authors: [] },
  };
  if (messages.length < ordered.length)
    snapshot.nextBefore = messages[0]?.createdSequence ?? projection.nextBefore;
  for (;;) {
    const authors = new Set(
      snapshot.messages.flatMap((message) => [
        message.authorId,
        ...(message.quote ? [message.quote.authorId] : []),
      ]),
    );
    snapshot.labels.authors = [...authorLabels.values()].filter((author) =>
      authors.has(author.id),
    );
    snapshot.byteLength = snapshotByteLength(snapshot);
    if (snapshot.byteLength <= HISTORY_BYTE_LIMIT) break;
    if (snapshot.messages.length === 0) return invalid();
    snapshot.messages.shift();
    snapshot.nextBefore =
      snapshot.messages[0]?.createdSequence ?? projection.nextBefore;
  }
  const checked = CachedSnapshotSchema.safeParse(snapshot);
  return checked.success ? { kind: "ok", value: checked.data } : invalid();
}
