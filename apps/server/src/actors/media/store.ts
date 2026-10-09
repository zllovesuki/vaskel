import type { ClosureEvent } from "./diagnostics";
import participationSchema from "./migrations/0001_participation.sql?raw";
import transportSchema from "./migrations/0002_transport.sql?raw";
import { queueOccupancy } from "./occupancy";
import type { Generated, Kysely } from "kysely";
import type {
  MediaRoomRef,
  MediaSnapshot,
  MediaPublication,
  MediaOutcome,
  MediaSubscription,
} from "@vaskel/contracts/media";
import { createActorDatabase } from "@/server/storage/actor-database";
import { migrateActorStorage } from "@/server/storage/actor-migrations";
import type { RealtimeClient } from "@/server/providers/realtime";
import type { MediaClosureCause } from "@/server/media/disposition";
export interface ParticipantRow {
  id: string;
  generation: number;
  user_id: string;
  session_id: string;
  client_id: string;
  token_hash: string;
  status: "joining" | "active" | "closing" | "left";
  lease_expires: number;
  permission_generation: number;
  control_version: number;
  muted: number;
  deafened: number;
  screen_revoked: number;
  reason: MediaClosureCause | null;
  cancellation_pending: number;
  closed_at: number | null;
  cleanup_at: number | null;
}
export interface SessionRow {
  session_key: string;
  participant_id: string;
  generation: number;
  direction: "producer" | "consumer";
  provider_id: string | null;
  version: number;
  phase:
    | "idle"
    | "moderating"
    | "requesting"
    | "awaiting_apply"
    | "awaiting_answer"
    | "answering"
    | "closed";
  operation_id: string | null;
  deadline: number;
}
export interface PublicationRow {
  id: string;
  participant_id: string;
  generation: number;
  source: MediaPublication["source"];
  session_key: string;
  mid: string;
  track_name: string;
  ready: number;
}
export interface MediaDatabase {
  media_occupancy: {
    id: Generated<1>;
    revision: number;
    summary: string;
    next_attempt_at: number | null;
    lease_id: string | null;
    lease_expires_at: number | null;
  };
  media_restrictions: {
    user_id: string;
    muted: number;
    deafened: number;
    screen_revoked: number;
  };
  media_room: { id: number; room: string; revision: number };
  media_participants: ParticipantRow;
  media_sessions: SessionRow;
  media_operations: {
    participant_id: string;
    generation: number;
    direction: string;
    operation_id: string;
    payload_hash: string;
    result: string | null;
    answer_hash: string | null;
    created_at: number;
  };
  media_moderation_receipts: {
    user_id: string;
    command_id: string;
    payload_hash: string;
    result: string;
    created_at: number;
  };
  media_allocations: { session_key: string; mid: string };
  media_publications: PublicationRow;
  media_subscriptions: {
    session_key: string;
    publication_id: string;
    mid: string;
    source_session_key: string;
    source_transferred: number;
  };
  media_permission_floors: { user_id: string; generation: number };
}
export interface RoomRuntime {
  ctx: DurableObjectState;
  env: Env;
  db: Kysely<MediaDatabase>;
  provider: RealtimeClient;
  inflight: Map<string, Promise<unknown>>;
  closureEvents?: ClosureEvent[];
}
export function openMediaDatabase(
  storage: DurableObjectStorage,
  actorId?: string,
) {
  migrateActorStorage(
    storage,
    [
      {
        version: 1,
        name: "media-room-participation",
        sql: participationSchema,
      },
      { version: 2, name: "media-room-transport", sql: transportSchema },
    ],
    { schema: "media_room", actorId },
  );
  return createActorDatabase<MediaDatabase>(storage);
}
export function sessionKey(
  id: string,
  generation: number,
  direction: "producer" | "consumer",
) {
  return `${id}:${generation}:${direction}`;
}
export function publicPublication(row: PublicationRow): MediaPublication {
  return {
    id: row.id,
    participantId: row.participant_id,
    source: row.source,
    generation: row.generation,
  };
}
export async function ensureRoom(rt: RoomRuntime, room: MediaRoomRef) {
  let state = await rt.db
    .selectFrom("media_room")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirst();
  if (!state) {
    await rt.db
      .insertInto("media_room")
      .values({ id: 1, room: JSON.stringify(room), revision: 0 })
      .execute();
    state = { id: 1, room: JSON.stringify(room), revision: 0 };
  }
  return state;
}
/** Retain every provider allocation before classifying or rejecting the response. */
export async function recordAllocations(
  rt: RoomRuntime,
  key: string,
  tracks: readonly { mid?: string | undefined }[],
) {
  for (const track of tracks)
    if (track.mid)
      await rt.db
        .insertInto("media_allocations")
        .values({ session_key: key, mid: track.mid })
        .onConflict((c) => c.columns(["session_key", "mid"]).doNothing())
        .execute();
}
export async function revision(rt: RoomRuntime, visible = true) {
  const state = await rt.db
    .selectFrom("media_room")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirstOrThrow();
  if (!visible) return state.revision;
  await rt.db
    .updateTable("media_room")
    .set({ revision: state.revision + 1 })
    .where("id", "=", 1)
    .execute();
  await queueOccupancy(rt, state.revision + 1);
  return state.revision + 1;
}
export async function roomSnapshot(
  rt: RoomRuntime,
  room: MediaRoomRef,
): Promise<MediaSnapshot> {
  const state = await ensureRoom(rt, room);
  const rows = await rt.db
    .selectFrom("media_participants as p")
    .selectAll("p")
    .where("p.status", "in", ["joining", "active"])
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("media_participants as newer")
            .select("newer.id")
            .whereRef("newer.id", "=", "p.id")
            .whereRef("newer.generation", ">", "p.generation"),
        ),
      ),
    )
    .orderBy("p.id")
    .limit(16)
    .execute();
  const publications = await rt.db
    .selectFrom("media_publications")
    .selectAll()
    .where("ready", "=", 1)
    .execute();
  return {
    room,
    revision: state.revision,
    participants: rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      generation: row.generation,
      controlVersion: row.control_version,
      muted: row.muted === 1,
      deafened: row.deafened === 1,
      screenRevoked: row.screen_revoked === 1,
      status: row.status === "left" ? "closing" : row.status,
      publications: publications
        .filter(
          (pub) =>
            pub.participant_id === row.id && pub.generation === row.generation,
        )
        .map(publicPublication),
    })),
  };
}
/** Call after local participant/exchange checks in the same native transaction. */
export async function completed(
  rt: RoomRuntime,
  session: SessionRow,
  operationId: string,
): Promise<MediaOutcome> {
  const result: MediaOutcome = {
    kind: "completed",
    operationId,
    sessionVersion: session.version,
    // Private subscription completion must not trigger another roster refresh.
    revision: await revision(rt, session.direction === "producer"),
    ...(session.direction === "consumer"
      ? { subscriptions: await currentSubscriptions(rt, session.session_key) }
      : {}),
  };
  await rt.db
    .updateTable("media_sessions")
    .set({ phase: "idle", operation_id: null, deadline: 0 })
    .where("session_key", "=", session.session_key)
    .execute();
  await rt.db
    .updateTable("media_operations")
    .set({ result: JSON.stringify(result) })
    .where("participant_id", "=", session.participant_id)
    .where("generation", "=", session.generation)
    .where("direction", "=", session.direction)
    .where("operation_id", "=", operationId)
    .execute();
  return result;
}

export async function currentSubscriptions(
  rt: RoomRuntime,
  key: string,
): Promise<MediaSubscription[]> {
  const rows = await rt.db
    .selectFrom("media_subscriptions")
    .innerJoin(
      "media_publications",
      "media_publications.id",
      "media_subscriptions.publication_id",
    )
    .selectAll("media_publications")
    .select("media_subscriptions.mid as receiving_mid")
    .where("media_subscriptions.session_key", "=", key)
    .where("media_publications.ready", "=", 1)
    .execute();
  return rows.map((row) => ({
    publication: publicPublication(row),
    mid: row.receiving_mid,
  }));
}
