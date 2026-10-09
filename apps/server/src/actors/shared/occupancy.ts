import { sql, type Kysely } from "kysely";
import type { MediaRoomRef } from "@vaskel/contracts/media";
import { OccupancySchema, type Occupancy } from "@vaskel/contracts/occupancy";
import type { OwnerDatabase } from "./database";
import { visibleChannels, getState } from "./policy";

export interface MediaOccupancyRequest {
  room: MediaRoomRef;
  occupancy: Occupancy;
}
export type MediaOccupancyOutcome =
  | { kind: "applied"; occupancyChanged: boolean }
  | { kind: "ignored" | "forbidden" };

/** Trusted room-to-owner RPC; current ownership and ordering remain actor-local. */
export function applyMediaOccupancy(
  storage: DurableObjectStorage,
  database: Kysely<OwnerDatabase>,
  request: MediaOccupancyRequest,
): Promise<MediaOccupancyOutcome> {
  return storage.transaction(async () => {
    const state = await getState(database);
    if (
      !state ||
      state.owner_kind !== request.room.owner.kind ||
      state.owner_id !== request.room.owner.id
    )
      return { kind: "forbidden" };
    const channel = await database
      .selectFrom("channels")
      .selectAll()
      .where("id", "=", request.room.channelId)
      .executeTakeFirst();
    if (
      !channel ||
      (state.owner_kind === "server"
        ? channel.kind !== "media"
        : channel.id !== state.owner_id)
    )
      return { kind: "forbidden" };
    const old = await database
      .selectFrom("channel_occupancy")
      .select(["revision", "summary"])
      .where("channel_id", "=", channel.id)
      .executeTakeFirst();
    if (old && old.revision >= request.occupancy.revision)
      return { kind: "ignored" };
    const row = {
      channel_id: channel.id,
      revision: request.occupancy.revision,
      summary: JSON.stringify(request.occupancy),
    };
    await database
      .insertInto("channel_occupancy")
      .values(row)
      .onConflict((conflict) => conflict.column("channel_id").doUpdateSet(row))
      .execute();
    const previous = old
      ? OccupancySchema.parse(JSON.parse(old.summary))
      : null;
    const current = request.occupancy;
    return {
      kind: "applied",
      occupancyChanged:
        !previous ||
        previous.startedAt !== current.startedAt ||
        JSON.stringify(previous.participantIds) !==
          JSON.stringify(current.participantIds) ||
        JSON.stringify(previous.sharingUserIds) !==
          JSON.stringify(current.sharingUserIds),
    };
  });
}

/** Viewer authorization and every participant/channel check share the directory transaction. */
export async function directoryOccupancy(
  database: Kysely<OwnerDatabase>,
  channels: readonly {
    id: string;
    occupancySummary: string | null;
    occupancyRevision: number | null;
  }[],
): Promise<Map<string, Occupancy>> {
  const summaries = new Map<string, Occupancy>();
  for (const channel of channels) {
    if (channel.occupancySummary === null) continue;
    const occupancy = OccupancySchema.parse(
      JSON.parse(channel.occupancySummary),
    );
    if (occupancy.participantIds.length)
      summaries.set(channel.id, {
        ...occupancy,
        revision: channel.occupancyRevision!,
      });
  }
  const candidates = [...summaries].flatMap(([channelId, occupancy]) =>
    occupancy.participantIds.map((userId) => ({ channelId, userId })),
  );
  const allowed = new Map<string, Set<string>>();
  // Two parameters per pair, below workerd's 100-parameter limit.
  for (let offset = 0; offset < candidates.length; offset += 40) {
    const pairs = candidates.slice(offset, offset + 40);
    const rows = await database
      .selectFrom(
        sql<{
          column1: string;
          column2: string;
        }>`(VALUES ${sql.join(pairs.map(({ channelId, userId }) => sql`(${channelId}, ${userId})`))})`.as(
          "candidates",
        ),
      )
      .innerJoin("channels", "channels.id", "candidates.column1")
      .innerJoin("members", "members.user_id", "candidates.column2")
      .select(["channels.id as channelId", "members.user_id as userId"])
      .where((eb) => visibleChannels(eb, eb.ref("members.user_id")))
      .execute();
    for (const row of rows) {
      const readers = allowed.get(row.channelId) ?? new Set<string>();
      readers.add(row.userId);
      allowed.set(row.channelId, readers);
    }
  }
  for (const [channelId, occupancy] of summaries) {
    const readers = allowed.get(channelId);
    const participantIds = occupancy.participantIds.filter((id) =>
      readers?.has(id),
    );
    if (participantIds.length)
      summaries.set(channelId, {
        ...occupancy,
        participantIds,
        sharingUserIds: occupancy.sharingUserIds.filter((id) =>
          readers?.has(id),
        ),
      });
    else summaries.delete(channelId);
  }
  return summaries;
}
