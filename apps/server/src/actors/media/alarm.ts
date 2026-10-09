import { mediaTransaction } from "@/server/actors/media/diagnostics";
import { closureDisposition } from "@/server/media/disposition";
import { MediaRoomRefSchema } from "@vaskel/contracts/media";
import {
  actorWork,
  ACTOR_WORK_BUDGET_MS,
} from "@/server/actors/shared/bounded-work";
import {
  retireTransferredParticipant,
  disposeTransferredParticipant,
} from "./disposal";
import { drainOccupancy, occupancyWake } from "./occupancy";
import { replaceAlarm } from "@/server/actors/shared/alarms";
import {
  closeParticipant,
  deferParticipantCleanup,
  markParticipantClosing,
} from "./cleanup";
import { mediaRetentionWake, pruneMediaRecords } from "./retention";
import type { ParticipantRow, RoomRuntime } from "./store";
import { logEvent } from "@/server/telemetry";

/** Complete fresh state and exact wake replacement share the native transaction. */
export function scheduleMediaAlarm(rt: RoomRuntime) {
  return mediaTransaction(rt, async (rt) => {
    const now = Date.now();
    const participants = (
      await rt.db
        .selectFrom("media_participants")
        .select((eb) => eb.fn.min<number | null>("lease_expires").as("at"))
        .where("status", "in", ["joining", "active"])
        .executeTakeFirstOrThrow()
    ).at;
    const cleanup = (
      await rt.db
        .selectFrom("media_participants")
        .select((eb) => eb.fn.min<number | null>("cleanup_at").as("at"))
        .executeTakeFirstOrThrow()
    ).at;
    const negotiation = (
      await rt.db
        .selectFrom("media_sessions as s")
        .innerJoin("media_participants as p", (join) =>
          join
            .onRef("p.id", "=", "s.participant_id")
            .onRef("p.generation", "=", "s.generation"),
        )
        .select((eb) => eb.fn.min<number | null>("s.deadline").as("at"))
        .where("s.deadline", ">", 0)
        .where("s.phase", "!=", "closed")
        .where("p.status", "in", ["joining", "active"])
        .executeTakeFirstOrThrow()
    ).at;
    const occupancy = await occupancyWake(rt);
    const deadlines = [
      participants,
      cleanup,
      negotiation,
      mediaRetentionWake(rt, now),
      occupancy === null ? null : occupancy <= now ? now + 1_000 : occupancy,
    ].filter((at) => at !== null);
    await replaceAlarm(
      rt.ctx.storage,
      deadlines.length ? Math.min(...deadlines) : null,
    );
  });
}

async function claimMediaCleanup(rt: RoomRuntime, now: number) {
  return mediaTransaction(rt, async (rt) => {
    // Only participating generations can acquire an expiry disposition.
    // Multiple expired sessions become one generation's cleanup obligation.
    const expired = await rt.db
      .selectFrom("media_participants as p")
      .selectAll("p")
      .where("p.status", "in", ["joining", "active"])
      .where((eb) =>
        eb.or([
          eb("p.lease_expires", "<=", now),
          eb.exists(
            eb
              .selectFrom("media_sessions as s")
              .select("s.session_key")
              .whereRef("s.participant_id", "=", "p.id")
              .whereRef("s.generation", "=", "p.generation")
              .where("s.deadline", ">", 0)
              .where("s.deadline", "<=", now)
              .where("s.phase", "!=", "closed"),
          ),
        ]),
      )
      .orderBy("p.lease_expires")
      .orderBy("p.id")
      .orderBy("p.generation")
      .limit(16)
      .execute();
    for (const p of expired) {
      if (p.lease_expires <= now)
        await markParticipantClosing(rt, p, "lease_expired", {
          kind: "lease",
          now,
        });
      else {
        const session = await rt.db
          .selectFrom("media_sessions")
          .selectAll()
          .where("participant_id", "=", p.id)
          .where("generation", "=", p.generation)
          .where("deadline", ">", 0)
          .where("deadline", "<=", now)
          .where("phase", "!=", "closed")
          .orderBy("deadline")
          .executeTakeFirstOrThrow();
        await markParticipantClosing(rt, p, "negotiation_expired", {
          kind: "negotiation",
          now,
          session,
        });
      }
    }
    const due = await rt.db
      .selectFrom("media_participants")
      .selectAll()
      .where("cleanup_at", "<=", Date.now())
      .orderBy("cleanup_at")
      .orderBy("id")
      .orderBy("generation")
      .limit(16)
      .execute();
    // Advance every selected row, including protected or unavailable slots,
    // so those rows cannot repeatedly occupy the head of the next batch.
    for (const p of due) await deferParticipantCleanup(rt, p);
    return due;
  });
}

async function cleanupMediaRoom(
  rt: RoomRuntime,
  pending: ParticipantRow[],
  now: number,
) {
  const deadline = now + ACTOR_WORK_BUDGET_MS;
  const counts = { processed: 0, pending: 0, failed: 0 };
  try {
    const failures: unknown[] = [];
    for (const p of pending) {
      try {
        counts.processed++;
        // Lost transfer notifications are repaired by the participant lease.
        if (
          p.status !== "left" &&
          closureDisposition(p.reason).kind !== "terminal"
        ) {
          const state = await rt.db
            .selectFrom("media_room")
            .select("room")
            .where("id", "=", 1)
            .executeTakeFirstOrThrow();
          const obsolete = await actorWork(rt.ctx.storage, "hints").run(
            () =>
              rt.env.ACCOUNT_MEDIA.getByName(p.user_id).isObsolete(
                MediaRoomRefSchema.parse(JSON.parse(state.room)),
                p.generation,
              ),
            deadline,
            `obsolete:${p.id}:${p.generation}`,
          );
          if (obsolete.ok && obsolete.value) {
            const retired = await mediaTransaction(rt, async (rt) => {
              const current = await rt.db
                .selectFrom("media_participants")
                .selectAll()
                .where("id", "=", p.id)
                .where("generation", "=", p.generation)
                .executeTakeFirst();
              return current
                ? retireTransferredParticipant(rt, current)
                : false;
            });
            if (retired) {
              await disposeTransferredParticipant(rt, p);
              continue;
            }
          }
        }
        if (
          !(await closeParticipant(
            rt,
            p,
            p.reason ?? "lease_expired",
            undefined,
            deadline,
          ))
        )
          counts.pending++;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
    pruneMediaRecords(rt, Date.now());
  } catch (error) {
    counts.failed++;
    throw error;
  } finally {
    if (counts.processed || counts.failed)
      logEvent(
        counts.pending || counts.failed ? "warn" : "log",
        "media_cleanup",
        {
          actorId: rt.ctx.id.toString(),
          durationMs: Date.now() - now,
          ...counts,
        },
      );
  }
}

export async function alarmMediaRoom(rt: RoomRuntime) {
  const now = Date.now();
  let pending: ParticipantRow[];
  try {
    pending = await claimMediaCleanup(rt, now);
  } catch (error) {
    // A failed local transition has no committed recovery claim. Leave retry
    // ownership to the platform instead of manufacturing an overdue wake loop.
    logEvent(
      "error",
      "media_alarm_failed",
      { actorId: rt.ctx.id.toString(), operation: "cleanup" },
      error,
    );
    throw error;
  }
  try {
    const results = await Promise.allSettled([
      cleanupMediaRoom(rt, pending, now),
      drainOccupancy(rt),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected")
        logEvent(
          "error",
          "media_alarm_failed",
          {
            actorId: rt.ctx.id.toString(),
            operation: index === 0 ? "cleanup" : "occupancy",
          },
          result.reason,
        );
    }
    if (failure?.status === "rejected") throw failure.reason;
  } finally {
    // A previous candidate's retry can become overdue while this pass waits for
    // another one. Advance only this pass's unsettled claims; freshly enqueued
    // generations keep their own eligibility and remain in the full refresh.
    await mediaTransaction(rt, async (rt) => {
      for (const p of pending) await deferParticipantCleanup(rt, p);
    });
    await scheduleMediaAlarm(rt);
  }
}
