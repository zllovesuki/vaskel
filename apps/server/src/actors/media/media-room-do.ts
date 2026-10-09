import { mediaTransaction } from "@/server/actors/media/diagnostics";
import {
  retireTransferredParticipant,
  disposeTransferredParticipant,
} from "./disposal";
import { DurableObject } from "cloudflare:workers";
import type { Principal } from "@/server/domain/principal";
import type {
  AccountClaim,
  MediaAuthorization,
} from "@/server/media/authorization";
import { authorizationError } from "@/server/media/runtime";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import {
  closureDisposition,
  type MediaClosureDisposition,
} from "@/server/media/disposition";
import { RealtimeClient } from "@/server/providers/realtime";
import {
  type MediaOutcome,
  type MediaRoomRef,
  type HeartbeatMediaRequest,
  type PublishMediaRequest,
  type SubscribeMediaRequest,
  type AckMediaRequest,
  type AnswerMediaRequest,
  type UnpublishMediaRequest,
  type ModerateMediaRequest,
} from "@vaskel/contracts/media";
import { authorizeLocalParticipant } from "@/server/actors/media/authorization";
import {
  closeParticipant,
  markParticipantClosing,
} from "@/server/actors/media/cleanup";
import {
  admitParticipant,
  type AdmitOutcome,
} from "@/server/actors/media/membership";
import {
  publish,
  ack,
  unpublish,
} from "@/server/actors/media/negotiation/publications";
import {
  subscribe,
  answer,
} from "@/server/actors/media/negotiation/subscriptions";
import { moderate } from "@/server/actors/media/moderation";
import { alarmMediaRoom, scheduleMediaAlarm } from "./alarm";
import {
  ensureRoom,
  openMediaDatabase,
  roomSnapshot,
  type RoomRuntime,
} from "@/server/actors/media/store";

export type EndClaim = {
  room: MediaRoomRef;
  participantId: string;
  generation: number;
  reason: "leave" | "replace" | "transfer";
};
export type CloseOutcome =
  { kind: "closed" } | { kind: "cleanup_pending"; generation: number };
export type EndClaimOutcome =
  | { kind: "closed"; disposition: MediaClosureDisposition }
  | {
      kind: "cleanup_pending";
      generation: number;
      disposition: MediaClosureDisposition;
    };
export class MediaRoomDO extends DurableObject<Env> {
  private readonly runtime: RoomRuntime;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = {
      ctx,
      env,
      db: openMediaDatabase(ctx.storage, ctx.id.toString()),
      provider: new RealtimeClient(env),
      inflight: new Map(),
    };
    void ctx.blockConcurrencyWhile(() => scheduleMediaAlarm(this.runtime));
  }
  admit(
    claim: AccountClaim,
    authorization: MediaAuthorization,
  ): Promise<AdmitOutcome> {
    return admitParticipant(this.runtime, claim, authorization);
  }
  async heartbeat(
    principal: Principal,
    authorization: MediaAuthorization,
    request: HeartbeatMediaRequest,
  ): Promise<MediaOutcome> {
    const rt = this.runtime;
    const denied = authorizationError(
      principal,
      authorization,
      request.handle.room,
    );
    if (denied) return denied;
    const claim = await rt.env.ACCOUNT_MEDIA.getByName(
      principal.userId,
    ).validateClaim(principal, request.handle);
    if (claim.kind !== "valid_claim") return claim;
    // Claim RPC is outside SQL; local authority, renewal and the roster share
    // one transaction so a departed self cannot accompany a successful heartbeat.
    return mediaTransaction(rt, async (rt) => {
      const authorized = await authorizeLocalParticipant(
        rt,
        principal,
        authorization,
        request.handle,
      );
      if (authorized.kind !== "participant") return authorized;
      await scheduleAlarm(rt.ctx.storage, authorization.expiresAt);
      return {
        kind: "heartbeat",
        expiresAt: authorization.expiresAt,
        snapshot: await roomSnapshot(rt, request.handle.room),
      };
    });
  }
  publish(
    principal: Principal,
    authorization: MediaAuthorization,
    request: PublishMediaRequest,
  ) {
    return publish(this.runtime, principal, authorization, request);
  }
  ack(
    principal: Principal,
    authorization: MediaAuthorization,
    request: AckMediaRequest,
  ) {
    return ack(this.runtime, principal, authorization, request);
  }
  subscribe(
    principal: Principal,
    authorization: MediaAuthorization,
    request: SubscribeMediaRequest,
  ) {
    return subscribe(this.runtime, principal, authorization, request);
  }
  answer(
    principal: Principal,
    authorization: MediaAuthorization,
    request: AnswerMediaRequest,
  ) {
    return answer(this.runtime, principal, authorization, request);
  }
  unpublish(
    principal: Principal,
    authorization: MediaAuthorization,
    request: UnpublishMediaRequest,
  ) {
    return unpublish(this.runtime, principal, authorization, request);
  }
  moderate(
    principal: Principal,
    authorization: MediaAuthorization,
    request: ModerateMediaRequest,
  ) {
    return moderate(this.runtime, principal, authorization, request);
  }
  async snapshot(
    principal: Principal,
    authorization: MediaAuthorization,
    request: { room: MediaRoomRef },
  ): Promise<MediaOutcome> {
    const denied = authorizationError(principal, authorization, request.room);
    if (denied) return denied;
    return this.ctx.storage.transaction(async () => ({
      kind: "media_snapshot",
      snapshot: await roomSnapshot(this.runtime, request.room),
    }));
  }
  async endClaim(request: EndClaim): Promise<EndClaimOutcome> {
    const rt = this.runtime;
    const p = await rt.db
      .selectFrom("media_participants")
      .selectAll()
      .where("id", "=", request.participantId)
      .where("generation", "=", request.generation)
      .executeTakeFirst();
    if (!p)
      return {
        kind: "closed",
        disposition: closureDisposition(request.reason),
      };
    if (request.reason === "transfer") {
      if (
        !(await rt.env.ACCOUNT_MEDIA.getByName(p.user_id).isObsolete(
          request.room,
          p.generation,
        ))
      )
        return {
          kind: "cleanup_pending",
          generation: p.generation,
          disposition: closureDisposition(p.reason),
        };
      const retired = await mediaTransaction(rt, async (rt) => {
        const current = await rt.db
          .selectFrom("media_participants")
          .selectAll()
          .where("id", "=", p.id)
          .where("generation", "=", p.generation)
          .executeTakeFirst();
        return current ? retireTransferredParticipant(rt, current) : false;
      });
      if (retired) await disposeTransferredParticipant(rt, p);
      // Terminal obligations stay with the existing durable cleanup alarm.
    } else await closeParticipant(rt, p, request.reason);
    const latest = await rt.db
      .selectFrom("media_participants")
      .select(["reason", "status"])
      .where("id", "=", p.id)
      .where("generation", "=", p.generation)
      .executeTakeFirst();
    // An obsolete settled generation may retire during the awaited close.
    // Its last observed terminal disposition is immutable after forwarding ends.
    const disposition = closureDisposition(
      latest?.reason ?? p.reason ?? request.reason,
    );
    return !latest || latest.status === "left"
      ? { kind: "closed", disposition }
      : {
          kind: "cleanup_pending",
          generation: request.generation,
          disposition,
        };
  }
  async invalidate(request: {
    room: MediaRoomRef;
    userIds: string[];
    permissionGeneration: number;
  }): Promise<CloseOutcome> {
    const rt = this.runtime;
    await mediaTransaction(rt, (rt) => ensureRoom(rt, request.room));
    for (const userId of request.userIds) {
      await mediaTransaction(rt, async (rt) => {
        const old = await rt.db
          .selectFrom("media_permission_floors")
          .selectAll()
          .where("user_id", "=", userId)
          .executeTakeFirst();
        await rt.db
          .insertInto("media_permission_floors")
          .values({
            user_id: userId,
            generation: Math.max(
              old?.generation ?? 0,
              request.permissionGeneration,
            ),
          })
          .onConflict((c) =>
            c.column("user_id").doUpdateSet({
              generation: Math.max(
                old?.generation ?? 0,
                request.permissionGeneration,
              ),
            }),
          )
          .execute();
      });
      const participants = await mediaTransaction(rt, async (rt) => {
        const candidates = await rt.db
          .selectFrom("media_participants")
          .selectAll()
          .where("user_id", "=", userId)
          .where("status", "!=", "left")
          .where("permission_generation", "<", request.permissionGeneration)
          .execute();
        for (const participant of candidates)
          await markParticipantClosing(rt, participant, "permission_revoked");
        if (candidates.length)
          await scheduleAlarm(this.ctx.storage, Date.now() + 1);
        return candidates;
      });
      const present = await rt.db
        .selectFrom("media_participants")
        .select("id")
        .where("user_id", "=", userId)
        .where("status", "!=", "left")
        .executeTakeFirst();
      if (!present)
        await rt.env.ACCOUNT_MEDIA.getByName(userId).recordUnadmittedRevocation(
          request.room,
          request.permissionGeneration,
        );
      for (const p of participants) {
        if (!(await closeParticipant(rt, p, "permission_revoked")))
          return { kind: "cleanup_pending", generation: p.generation };
      }
    }
    return { kind: "closed" };
  }
  override alarm() {
    return alarmMediaRoom(this.runtime);
  }
}
