import { mediaTransaction } from "@/server/actors/media/diagnostics";
import {
  MediaOutcomeSchema,
  type ModerateMediaRequest,
  type MediaOutcome,
} from "@vaskel/contracts/media";
import type { Principal } from "@/server/domain/principal";
import type { MediaAuthorization } from "@/server/media/authorization";
import { authorizationError } from "@/server/media/runtime";
import { sha256Hex } from "@/server/auth/crypto";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import {
  closeMids,
  closeParticipant,
  markParticipantClosing,
} from "@/server/actors/media/cleanup";
import { providerFailure } from "@/server/actors/media/membership";
import { allocationScope } from "./operations";
import { MEDIA_TERMINAL_RETENTION_MS } from "./retention";
import {
  ensureRoom,
  revision,
  type RoomRuntime,
  type SessionRow,
} from "@/server/actors/media/store";

export async function moderate(
  rt: RoomRuntime,
  principal: Principal,
  authorization: MediaAuthorization,
  request: ModerateMediaRequest,
): Promise<MediaOutcome> {
  const hash = await sha256Hex(
    JSON.stringify({
      room: {
        owner: { kind: request.room.owner.kind, id: request.room.owner.id },
        channelId: request.room.channelId,
      },
      userId: request.userId,
      action: request.action,
      enabled: request.enabled,
      participantGeneration: request.participantGeneration,
      expectedControlVersion: request.expectedControlVersion,
    }),
  );
  const reserved = await mediaTransaction(rt, async (rt) => {
    const denied = authorizationError(principal, authorization, request.room);
    if (denied) return denied;
    if (!authorization.canModerate) return { kind: "forbidden" as const };
    await ensureRoom(rt, request.room);
    const prior = await rt.db
      .selectFrom("media_moderation_receipts")
      .selectAll()
      .where("user_id", "=", principal.userId)
      .where("command_id", "=", request.commandId)
      .executeTakeFirst();
    if (prior)
      return prior.payload_hash === hash
        ? MediaOutcomeSchema.parse(JSON.parse(prior.result))
        : { kind: "command_conflict" as const };
    if (request.action === "remove" && !request.enabled)
      return { kind: "invalid_input" as const };
    const p = await rt.db
      .selectFrom("media_participants")
      .selectAll()
      .where("user_id", "=", request.userId)
      .orderBy("generation", "desc")
      .executeTakeFirst();
    if (
      !p ||
      p.status === "left" ||
      p.generation !== request.participantGeneration ||
      p.control_version !== request.expectedControlVersion
    )
      return { kind: "moderation_changed" as const };
    let participant = p;
    let scoped: SessionRow | null = null;
    if (request.action === "remove") {
      participant = (await markParticipantClosing(rt, p, "removed"))!;
      await scheduleAlarm(rt.ctx.storage, Date.now() + 1);
    } else {
      if (request.enabled && p.status !== "closing") {
        const session = await rt.db
          .selectFrom("media_sessions")
          .selectAll()
          .where("participant_id", "=", p.id)
          .where("generation", "=", p.generation)
          .where(
            "direction",
            "=",
            request.action === "deafen" ? "consumer" : "producer",
          )
          .executeTakeFirstOrThrow();
        if (session.phase === "moderating")
          return {
            kind: "session_busy" as const,
            operationId: session.operation_id!,
          };
        if (session.phase === "idle") {
          // Scoped enforcement owns this session until provider settlement. Keep
          // the browser's negotiation version; moderation does not exchange SDP.
          scoped = {
            ...session,
            phase: "moderating",
            operation_id: request.commandId,
            deadline: Date.now() + 10_000,
          };
          await rt.db
            .updateTable("media_sessions")
            .set(scoped)
            .where("session_key", "=", session.session_key)
            .execute();
          await scheduleAlarm(rt.ctx.storage, scoped.deadline);
        } else {
          // A pending exchange cannot become valid again when a restriction lifts.
          participant = (await markParticipantClosing(
            rt,
            p,
            "moderation_cleanup",
          ))!;
        }
      }
      const restrictions = {
        muted: request.action === "mute" ? Number(request.enabled) : p.muted,
        deafened:
          request.action === "deafen" ? Number(request.enabled) : p.deafened,
        screen_revoked:
          request.action === "screen_revoke"
            ? Number(request.enabled)
            : p.screen_revoked,
      };
      await rt.db
        .insertInto("media_restrictions")
        .values({ user_id: p.user_id, ...restrictions })
        .onConflict((c) => c.column("user_id").doUpdateSet(restrictions))
        .execute();
      await rt.db
        .updateTable("media_participants")
        .set(restrictions)
        .where("id", "=", p.id)
        .where("generation", "=", p.generation)
        .execute();
      if (request.enabled && request.action !== "deafen") {
        await rt.db
          .updateTable("media_publications")
          .set({ ready: 0 })
          .where("participant_id", "=", p.id)
          .where("generation", "=", p.generation)
          .where(
            "source",
            "in",
            request.action === "mute"
              ? ["microphone", "screen_audio"]
              : ["screen_video", "screen_audio"],
          )
          .execute();
      }
    }
    await rt.db
      .updateTable("media_participants")
      .set({ control_version: p.control_version + 1 })
      .where("id", "=", p.id)
      .where("generation", "=", p.generation)
      .execute();
    const result = {
      kind: "moderated" as const,
      revision: await revision(rt),
      cleanupPending: scoped !== null || participant.status === "closing",
    };
    const now = Date.now();
    await rt.db
      .insertInto("media_moderation_receipts")
      .values({
        user_id: principal.userId,
        command_id: request.commandId,
        payload_hash: hash,
        result: JSON.stringify(result),
        created_at: now,
      })
      .execute();
    await scheduleAlarm(rt.ctx.storage, now + MEDIA_TERMINAL_RETENTION_MS);
    return { kind: "reserved" as const, participant, scoped, result };
  });
  if (reserved.kind !== "reserved") return reserved;
  const p = reserved.participant;
  const complete = async (cleanupPending: boolean): Promise<MediaOutcome> => {
    const result = { ...reserved.result, cleanupPending };
    await rt.db
      .updateTable("media_moderation_receipts")
      .set({ result: JSON.stringify(result) })
      .where("user_id", "=", principal.userId)
      .where("command_id", "=", request.commandId)
      .where("payload_hash", "=", hash)
      .execute();
    return result;
  };
  if (p.status === "closing")
    return complete(
      !(await closeParticipant(rt, p, p.reason ?? "moderation_cleanup")),
    );
  const session = reserved.scoped;
  if (!session) return reserved.result;
  const release = allocationScope(rt, session.session_key);
  try {
    const publications =
      session.direction === "producer"
        ? await rt.db
            .selectFrom("media_publications")
            .selectAll()
            .where("session_key", "=", session.session_key)
            .where(
              "source",
              "in",
              request.action === "mute"
                ? ["microphone", "screen_audio"]
                : ["screen_video", "screen_audio"],
            )
            .execute()
        : [];
    const mids =
      session.direction === "producer"
        ? publications.map((pub) => pub.mid)
        : (
            await rt.db
              .selectFrom("media_allocations")
              .select("mid")
              .where("session_key", "=", session.session_key)
              .execute()
          ).map((allocation) => allocation.mid);
    await closeMids(rt, session, mids);
    return await mediaTransaction(rt, async (rt) => {
      const current = await rt.db
        .selectFrom("media_sessions")
        .selectAll()
        .where("session_key", "=", session.session_key)
        .executeTakeFirst();
      if (
        !current ||
        current.phase !== "moderating" ||
        current.operation_id !== request.commandId ||
        current.version !== session.version
      )
        return reserved.result;
      if (session.direction === "producer") {
        if (publications.length)
          await rt.db
            .deleteFrom("media_publications")
            .where(
              "id",
              "in",
              publications.map((pub) => pub.id),
            )
            .execute();
      } else {
        await rt.db
          .deleteFrom("media_subscriptions")
          .where("session_key", "=", session.session_key)
          .execute();
      }
      await rt.db
        .updateTable("media_sessions")
        .set({ phase: "idle", operation_id: null, deadline: 0 })
        .where("session_key", "=", session.session_key)
        .execute();
      return complete(false);
    });
  } catch (error) {
    // Release our scope before terminal cleanup waits for every session owner.
    release();
    await closeParticipant(rt, p, "moderation_cleanup");
    // Classify provider failures, but retain the already-accepted restriction and
    // its pending receipt. SQL/invariant errors remain unexpected exceptions.
    providerFailure(error);
    return reserved.result;
  } finally {
    release();
  }
}
