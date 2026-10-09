import { OccupancySchema } from "@vaskel/contracts/occupancy";
import { MediaRoomRefSchema } from "@vaskel/contracts/media";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import type {
  MediaOccupancyRequest,
  MediaOccupancyOutcome,
} from "@/server/actors/shared/occupancy";
import type { RoomRuntime } from "./store";
import {
  actorWork,
  ACTOR_WORK_BUDGET_MS,
} from "@/server/actors/shared/bounded-work";

/** Caller owns the visibility-change transaction and has advanced room revision. */
export async function queueOccupancy(rt: RoomRuntime, revision: number) {
  const previous = await rt.db
    .selectFrom("media_occupancy")
    .selectAll()
    .where("id", "=", 1)
    .executeTakeFirst();
  const old = previous
    ? OccupancySchema.parse(JSON.parse(previous.summary))
    : null;
  const participantIds = (
    await rt.db
      .selectFrom("media_participants")
      .select("user_id")
      .distinct()
      .where("status", "=", "active")
      .orderBy("user_id")
      .execute()
  ).map((row) => row.user_id);
  const sharingUserIds = (
    await rt.db
      .selectFrom("media_participants as p")
      .innerJoin("media_publications as v", (join) =>
        join
          .onRef("v.participant_id", "=", "p.id")
          .onRef("v.generation", "=", "p.generation"),
      )
      .select("p.user_id")
      .distinct()
      .where("p.status", "=", "active")
      .where("p.screen_revoked", "=", 0)
      .where("v.ready", "=", 1)
      .where("v.source", "=", "screen_video")
      .orderBy("p.user_id")
      .execute()
  ).map((row) => row.user_id);
  // Every visible change needs a call hint, including camera and moderation
  // changes that leave the Home occupancy summary unchanged.
  const now = Date.now();
  const summary = OccupancySchema.parse({
    revision,
    participantIds,
    sharingUserIds,
    startedAt: participantIds.length ? (old?.startedAt ?? now) : null,
  });
  // Keep writes native: the installed DO dialect adds unused mutation metadata reads.
  rt.ctx.storage.sql.exec(
    `INSERT INTO media_occupancy(id,revision,summary,next_attempt_at) VALUES(1,?,?,?)
     ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,summary=excluded.summary,
       next_attempt_at=excluded.next_attempt_at,lease_id=NULL,lease_expires_at=NULL`,
    revision,
    JSON.stringify(summary),
    now,
  );
  await scheduleAlarm(rt.ctx.storage, now + 1_000);
}

export async function occupancyWake(rt: RoomRuntime): Promise<number | null> {
  const row = await rt.db
    .selectFrom("media_occupancy")
    .select((eb) =>
      eb.fn
        .min<number | null>(
          eb.fn<number>("max", [
            "next_attempt_at",
            eb.fn.coalesce("lease_expires_at", eb.val(0)),
          ]),
        )
        .as("at"),
    )
    .where("next_attempt_at", "is not", null)
    .executeTakeFirstOrThrow();
  return row.at;
}

/** Claims and acknowledgements are local; owner RPC never runs inside SQL. */
export async function drainOccupancy(
  rt: RoomRuntime,
  send: (request: MediaOccupancyRequest) => Promise<MediaOccupancyOutcome> = (
    request,
  ) =>
    request.room.owner.kind === "server"
      ? rt.env.SERVER_DO.getByName(request.room.owner.id).applyMediaOccupancy(
          request,
        )
      : rt.env.CONVERSATION_DO.getByName(
          request.room.owner.id,
        ).applyMediaOccupancy(request),
) {
  const deadline = Date.now() + ACTOR_WORK_BUDGET_MS;
  const claim = await rt.ctx.storage.transaction(async () => {
    const now = Date.now();
    const row = await rt.db
      .selectFrom("media_occupancy")
      .selectAll()
      .where("next_attempt_at", "<=", now)
      .where((eb) =>
        eb.or([
          eb("lease_expires_at", "is", null),
          eb("lease_expires_at", "<=", now),
        ]),
      )
      .executeTakeFirst();
    if (!row) return null;
    const leaseId = crypto.randomUUID();
    rt.ctx.storage.sql.exec(
      "UPDATE media_occupancy SET lease_id=?,lease_expires_at=? WHERE id=1",
      leaseId,
      now + 30_000,
    );
    await scheduleAlarm(rt.ctx.storage, now + 30_000);
    const state = await rt.db
      .selectFrom("media_room")
      .select("room")
      .where("id", "=", 1)
      .executeTakeFirstOrThrow();
    return {
      revision: row.revision,
      leaseId,
      request: {
        room: MediaRoomRefSchema.parse(JSON.parse(state.room)),
        occupancy: OccupancySchema.parse(JSON.parse(row.summary)),
      },
    };
  });
  if (!claim) return;
  const result = await actorWork(rt.ctx.storage, "maintenance").run(
    () => send(claim.request),
    deadline,
    "occupancy",
  );
  // An owner mismatch is permanent; uncertain delivery retains the obligation.
  const delivered =
    result.ok &&
    (result.value.kind === "applied" ||
      result.value.kind === "ignored" ||
      result.value.kind === "forbidden");
  await rt.ctx.storage.transaction(async () => {
    rt.ctx.storage.sql.exec(
      `UPDATE media_occupancy SET next_attempt_at=?,lease_id=NULL,lease_expires_at=NULL
       WHERE id=1 AND revision=? AND lease_id=?`,
      delivered ? null : Date.now() + 1_000,
      claim.revision,
      claim.leaseId,
    );
    const next = await occupancyWake(rt);
    if (next !== null) await scheduleAlarm(rt.ctx.storage, next);
  });
}
