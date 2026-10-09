import {
  mediaTransaction,
  recordClosure,
  sessionContext,
} from "@/server/actors/media/diagnostics";
import {
  actorWork,
  ACTOR_RPC_TIMEOUT_MS,
} from "@/server/actors/shared/bounded-work";
import { sql } from "kysely";
import { logEvent } from "@/server/telemetry";
import {
  RealtimeError,
  isAbsentSession,
  isAbsentTrack,
} from "@/server/providers/realtime";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import { MEDIA_TERMINAL_RETENTION_MS } from "./retention";
import { MediaRoomRefSchema, type MediaHandle } from "@vaskel/contracts/media";
import {
  closureDisposition,
  participationDisposition,
  type MediaClosureCause,
} from "@/server/media/disposition";
import {
  recordAllocations,
  revision,
  type RoomRuntime,
  type ParticipantRow,
  type SessionRow,
} from "@/server/actors/media/store";

type ExpiryCondition =
  | { kind: "lease"; now: number }
  | { kind: "negotiation"; now: number; session: SessionRow };

/** The caller owns the native transaction; never perform provider/RPC I/O here. */
export async function markParticipantClosing(
  rt: RoomRuntime,
  participant: Pick<ParticipantRow, "id" | "generation">,
  reason: MediaClosureCause,
  expiry?: ExpiryCondition,
): Promise<ParticipantRow | null> {
  const current = await rt.db
    .selectFrom("media_participants")
    .selectAll()
    .where("id", "=", participant.id)
    .where("generation", "=", participant.generation)
    .executeTakeFirst();
  if (!current) return null;
  // Forwarding completion is the closure barrier. Its returned disposition
  // must remain immutable once AccountMediaDO can admit a replacement.
  if (current.status === "left") return current;
  if (current.status !== "closing" && expiry) {
    if (expiry.kind === "lease") {
      if (current.lease_expires > expiry.now) return null;
    } else {
      const session = await rt.db
        .selectFrom("media_sessions")
        .selectAll()
        .where("session_key", "=", expiry.session.session_key)
        .executeTakeFirst();
      if (
        !session ||
        session.operation_id !== expiry.session.operation_id ||
        session.version !== expiry.session.version ||
        session.phase !== expiry.session.phase ||
        session.deadline !== expiry.session.deadline ||
        session.deadline === 0 ||
        session.deadline > expiry.now
      )
        return null;
    }
  }
  const cause =
    current.reason === null ||
    (closureDisposition(current.reason).kind !== "terminal" &&
      closureDisposition(reason).kind === "terminal")
      ? reason
      : current.reason;
  const next: ParticipantRow = {
    ...current,
    status: "closing",
    reason: cause,
    cleanup_at: current.cleanup_at ?? Date.now(),
    cancellation_pending:
      cause !== current.reason &&
      (cause === "removed" || cause === "permission_revoked")
        ? 1
        : current.cancellation_pending,
  };
  await rt.db
    .updateTable("media_participants")
    .set(next)
    .where("id", "=", participant.id)
    .where("generation", "=", participant.generation)
    .execute();
  await rt.db
    .updateTable("media_publications")
    .set({ ready: 0 })
    .where("participant_id", "=", participant.id)
    .where("generation", "=", participant.generation)
    .execute();
  if (current.status !== next.status || current.reason !== cause)
    await revision(rt);
  await scheduleAlarm(
    rt.ctx.storage,
    Math.max(Date.now() + 1_000, next.cleanup_at!),
  );
  recordClosure(rt, current, cause);
  return next;
}

async function acknowledgeCancellation(
  rt: RoomRuntime,
  participant: ParticipantRow,
) {
  if (!participant.cancellation_pending) return true;
  const disposition = closureDisposition(participant.reason);
  if (disposition.kind !== "terminal")
    throw new Error("Pending media cancellation must be terminal.");
  const state = await rt.db
    .selectFrom("media_room")
    .select("room")
    .where("id", "=", 1)
    .executeTakeFirstOrThrow();
  try {
    await rt.env.ACCOUNT_MEDIA.getByName(participant.user_id).recordRemoval(
      MediaRoomRefSchema.parse(JSON.parse(state.room)),
      participant.generation,
      disposition.reason,
    );
  } catch {
    return false;
  }
  await mediaTransaction(rt, async (rt) => {
    const now = Date.now();
    await rt.db
      .updateTable("media_participants")
      .set({
        cancellation_pending: 0,
        cleanup_at: sql`CASE WHEN status='left' THEN NULL ELSE cleanup_at END`,
        closed_at: sql`CASE WHEN status='left' THEN ${now} ELSE closed_at END`,
      })
      .where("id", "=", participant.id)
      .where("generation", "=", participant.generation)
      .where("reason", "=", participant.reason)
      .where("cancellation_pending", "=", 1)
      .execute();
    await scheduleAlarm(rt.ctx.storage, now + MEDIA_TERMINAL_RETENTION_MS);
  });
  return true;
}

export async function closedParticipation(
  rt: RoomRuntime,
  handle: MediaHandle,
) {
  const participant = await rt.db
    .selectFrom("media_participants")
    .select("reason")
    .where("id", "=", handle.participantId)
    .where("generation", "=", handle.accountGeneration)
    .executeTakeFirst();
  return participationDisposition(handle, participant?.reason ?? null);
}

export async function closeParticipant(
  rt: RoomRuntime,
  participant: ParticipantRow,
  reason: MediaClosureCause,
  expiry?: ExpiryCondition,
  deadline = Date.now() + ACTOR_RPC_TIMEOUT_MS,
): Promise<boolean> {
  const closing = await mediaTransaction(rt, async (rt) => {
    const current = await markParticipantClosing(
      rt,
      participant,
      reason,
      expiry,
    );
    if (!current || current.cleanup_at === null) return null;
    // Claim a successor even if another caller owns the still-running attempt.
    await deferParticipantCleanup(rt, current);
    return current;
  });
  if (!closing) return true;
  const key = `cleanup:${closing.id}:${closing.generation}`;
  const result = await actorWork(rt.ctx.storage, "maintenance").run(
    async () => {
      const task = (async () => {
        try {
          return await finishParticipantClosure(rt, closing);
        } finally {
          rt.inflight.delete(key);
          await mediaTransaction(rt, async (rt) => {
            await deferParticipantCleanup(rt, closing);
          });
        }
      })();
      rt.inflight.set(key, task);
      try {
        return { completed: await task };
      } catch (error) {
        // Preserve unexpected errors even after the bounded caller wait ends.
        logEvent(
          "error",
          "media_alarm_failed",
          {
            actorId: rt.ctx.id.toString(),
            operation: "cleanup",
          },
          error,
        );
        return { error };
      }
    },
    deadline,
    key,
  );
  if (result.ok && "error" in result.value) throw result.value.error;
  if (result.ok && result.value.completed) return true;
  await mediaTransaction(rt, (rt) => deferParticipantCleanup(rt, closing));
  return false;
}

/** Caller holds the native transaction; completion can already have cleared it. */
export async function deferParticipantCleanup(
  rt: RoomRuntime,
  participant: Pick<ParticipantRow, "id" | "generation">,
) {
  const at = Date.now() + 1_000;
  const updated = await rt.db
    .updateTable("media_participants")
    .set({ cleanup_at: at })
    .where("id", "=", participant.id)
    .where("generation", "=", participant.generation)
    .where("cleanup_at", "is not", null)
    .returning("id")
    .executeTakeFirst();
  if (updated) await scheduleAlarm(rt.ctx.storage, at);
}

async function finishParticipantClosure(
  rt: RoomRuntime,
  closing: ParticipantRow,
): Promise<boolean> {
  const participant = closing;
  if (closing.status === "left") return acknowledgeCancellation(rt, closing);
  let sessions = await rt.db
    .selectFrom("media_sessions")
    .selectAll()
    .where("participant_id", "=", participant.id)
    .where("generation", "=", participant.generation)
    .execute();
  await Promise.allSettled(
    sessions.flatMap((session) => [
      rt.inflight.get(session.session_key),
      rt.inflight.get(`scope:${session.session_key}`),
    ]),
  );
  sessions = await rt.db
    .selectFrom("media_sessions")
    .selectAll()
    .where("participant_id", "=", participant.id)
    .where("generation", "=", participant.generation)
    .execute();
  let converged = true;
  for (const session of sessions) {
    if (!session.provider_id) {
      await rt.db
        .updateTable("media_sessions")
        .set({ phase: "closed", operation_id: null, deadline: 0 })
        .where("session_key", "=", session.session_key)
        .execute();
      continue;
    }
    try {
      const context = {
        ...sessionContext(rt, session),
        cleanup: "session" as const,
      };
      const remote = await rt.provider.getSession(session.provider_id, context);
      await recordAllocations(rt, session.session_key, remote.tracks);
      const allocations = await rt.db
        .selectFrom("media_allocations")
        .selectAll()
        .where("session_key", "=", session.session_key)
        .execute();
      if (allocations.length) {
        const response = await rt.provider.closeTracks(
          session.provider_id,
          allocations.map((a) => a.mid),
          context,
        );
        if (response.requiresImmediateRenegotiation) {
          converged = false;
          continue;
        }
        const results = new Map(
          response.tracks
            .filter((track) => track.mid)
            .map((track) => [track.mid, track]),
        );
        for (const allocation of allocations) {
          const result = results.get(allocation.mid);
          if (!result || (result.errorCode && !isAbsentTrack(result))) {
            converged = false;
            continue;
          }
          await rt.db
            .deleteFrom("media_allocations")
            .where("session_key", "=", session.session_key)
            .where("mid", "=", allocation.mid)
            .execute();
        }
      }
    } catch (error) {
      // The durable closing marker and alarm already exist. Local failures
      // must remain unexpected exceptions, rather than provider outcomes.
      if (!(error instanceof RealtimeError)) throw error;
      if (!isAbsentSession(error)) {
        converged = false;
        continue;
      }
      await rt.db
        .deleteFrom("media_allocations")
        .where("session_key", "=", session.session_key)
        .execute();
    }
    const remaining = await rt.db
      .selectFrom("media_allocations")
      .select("mid")
      .where("session_key", "=", session.session_key)
      .execute();
    if (remaining.length) converged = false;
    else
      await rt.db
        .updateTable("media_sessions")
        .set({ phase: "closed", operation_id: null, deadline: 0 })
        .where("session_key", "=", session.session_key)
        .execute();
  }
  if (converged) {
    await mediaTransaction(rt, async (rt) => {
      const current = await rt.db
        .selectFrom("media_participants")
        .select("status")
        .where("id", "=", participant.id)
        .where("generation", "=", participant.generation)
        .executeTakeFirstOrThrow();
      if (current.status === "left") return;
      await rt.db
        .updateTable("media_participants")
        .set({
          status: "left",
          closed_at: Date.now(),
          cleanup_at: sql`CASE WHEN cancellation_pending=0 THEN NULL ELSE cleanup_at END`,
        })
        .where("id", "=", participant.id)
        .where("generation", "=", participant.generation)
        .execute();
      if (sessions.length)
        await rt.db
          .deleteFrom("media_subscriptions")
          .where(
            "session_key",
            "in",
            sessions.map((s) => s.session_key),
          )
          .execute();
      await revision(rt);
      await scheduleAlarm(
        rt.ctx.storage,
        Date.now() + MEDIA_TERMINAL_RETENTION_MS,
      );
    });
  }
  const latest = await rt.db
    .selectFrom("media_participants")
    .selectAll()
    .where("id", "=", participant.id)
    .where("generation", "=", participant.generation)
    .executeTakeFirstOrThrow();
  return (await acknowledgeCancellation(rt, latest)) && converged;
}
export async function closeMids(
  rt: RoomRuntime,
  session: SessionRow,
  mids: string[],
) {
  if (!mids.length) return;
  if (!session.provider_id)
    throw new Error("Allocated tracks require a provider session.");
  const result = await rt.provider.closeTracks(session.provider_id, mids, {
    ...sessionContext(rt, session),
    cleanup: "tracks",
  });
  if (result.requiresImmediateRenegotiation)
    throw new RealtimeError("cleanup_requires_negotiation", 502, false, true);
  const indexed = new Map(result.tracks.map((track) => [track.mid, track]));
  for (const mid of mids) {
    const item = indexed.get(mid);
    if (!item || (item.errorCode && !isAbsentTrack(item)))
      throw new RealtimeError("cleanup_incomplete", 502, true, true);
    await rt.db
      .deleteFrom("media_allocations")
      .where("session_key", "=", session.session_key)
      .where("mid", "=", mid)
      .execute();
  }
}
