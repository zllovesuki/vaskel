import { mediaTransaction } from "@/server/actors/media/diagnostics";
import {
  retireTransferredParticipant,
  disposeTransferredParticipant,
} from "./disposal";
import { pruneMediaRecords } from "./retention";
import type { MediaFailure } from "@vaskel/contracts/media";
import type {
  AccountClaim,
  MediaAuthorization,
  MediaAdmissionOutcome,
} from "@/server/media/authorization";
import { grantError } from "@/server/media/runtime";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import { RealtimeError } from "@/server/providers/realtime";
import { closureDisposition } from "@/server/media/disposition";
import { closeParticipant } from "@/server/actors/media/cleanup";
import {
  ensureRoom,
  revision,
  roomSnapshot,
  sessionKey,
  type RoomRuntime,
} from "@/server/actors/media/store";
export type AdmitOutcome = MediaAdmissionOutcome;
export function providerFailure(error: unknown): MediaFailure {
  if (!(error instanceof RealtimeError)) throw error;
  return {
    kind: "provider_error",
    code: error.code,
    retryable: error.retryable,
    uncertain: error.uncertain,
  };
}
async function admitLogicalParticipant(
  rt: RoomRuntime,
  claim: AccountClaim,
  authorization: MediaAuthorization,
): Promise<AdmitOutcome> {
  if (!rt.provider.configured) return { kind: "unavailable" };
  const denied = grantError(claim, authorization, claim.room);
  if (denied) return denied;
  const valid = await rt.env.ACCOUNT_MEDIA.getByName(
    claim.userId,
  ).validateAdmission(claim);
  if (valid.kind !== "valid_claim") return valid;
  pruneMediaRecords(rt, Date.now());
  const reserved = await mediaTransaction(rt, async (rt) => {
    const denied = grantError(claim, authorization, claim.room);
    if (denied) return denied;
    await ensureRoom(rt, claim.room);
    const floor = await rt.db
      .selectFrom("media_permission_floors")
      .selectAll()
      .where("user_id", "=", claim.userId)
      .executeTakeFirst();
    if (authorization.permissionGeneration < (floor?.generation ?? 0))
      return {
        kind: "participation_ended" as const,
        generation: claim.generation,
        reason: "permission_revoked" as const,
      };
    const newer = await rt.db
      .selectFrom("media_participants")
      .select("generation")
      .where("id", "=", claim.participantId)
      .where("generation", ">", claim.generation)
      .orderBy("generation", "desc")
      .executeTakeFirst();
    if (newer)
      return {
        kind: "stale_generation" as const,
        currentGeneration: newer.generation,
      };
    const prior = await rt.db
      .selectFrom("media_participants")
      .selectAll()
      .where("id", "=", claim.participantId)
      .where("generation", "=", claim.generation)
      .executeTakeFirst();
    if (prior) {
      if (
        prior.token_hash !== claim.tokenHash ||
        prior.session_id !== claim.sessionId ||
        prior.client_id !== claim.clientId ||
        prior.user_id !== claim.userId
      )
        return { kind: "forbidden" as const };
      if (prior.status === "closing" || prior.status === "left")
        return admissionDisposition(claim.generation, prior.reason);
      return prior;
    }
    const predecessors = await rt.db
      .selectFrom("media_participants")
      .selectAll()
      .where("id", "=", claim.participantId)
      .where("generation", "!=", claim.generation)
      .where("status", "!=", "left")
      .execute();
    for (const predecessor of predecessors)
      await retireTransferredParticipant(rt, predecessor);
    const count = await rt.db
      .selectFrom("media_participants")
      .select((eb) => eb.fn.count<number>("user_id").distinct().as("count"))
      .where("status", "in", ["joining", "active"])
      .executeTakeFirstOrThrow();
    if (count.count >= 16) return { kind: "capacity" as const };
    // Bound retained resource work separately from the logical room roster.
    const resources = await rt.db
      .selectFrom("media_sessions")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    if (resources.count + 2 > 128) return { kind: "capacity" as const };
    const restrictions = await rt.db
      .selectFrom("media_restrictions")
      .selectAll()
      .where("user_id", "=", claim.userId)
      .executeTakeFirst();
    const p = {
      id: claim.participantId,
      generation: claim.generation,
      user_id: claim.userId,
      session_id: claim.sessionId,
      client_id: claim.clientId,
      token_hash: claim.tokenHash,
      status: "joining" as const,
      lease_expires: authorization.expiresAt,
      permission_generation: authorization.permissionGeneration,
      control_version: 0,
      muted: restrictions?.muted ?? 0,
      deafened: restrictions?.deafened ?? 0,
      screen_revoked: restrictions?.screen_revoked ?? 0,
      reason: null,
      cancellation_pending: 0,
      closed_at: null,
      cleanup_at: null,
    };
    await rt.db.insertInto("media_participants").values(p).execute();
    for (const direction of ["producer", "consumer"] as const)
      await rt.db
        .insertInto("media_sessions")
        .values({
          session_key: sessionKey(p.id, p.generation, direction),
          participant_id: p.id,
          generation: p.generation,
          direction,
          provider_id: null,
          version: 0,
          phase: "idle",
          operation_id: null,
          deadline: 0,
        })
        .execute();
    await scheduleAlarm(rt.ctx.storage, authorization.expiresAt);
    return p;
  });
  if ("kind" in reserved) return reserved;
  const retired = await rt.db
    .selectFrom("media_participants")
    .selectAll()
    .where("id", "=", claim.participantId)
    .where("reason", "=", "transfer")
    .execute();
  for (const predecessor of retired)
    await disposeTransferredParticipant(rt, predecessor);
  pruneMediaRecords(rt, Date.now());
  const fresh = await rt.env.ACCOUNT_MEDIA.getByName(
    claim.userId,
  ).validateAdmission(claim);
  if (fresh.kind !== "valid_claim" || authorization.expiresAt <= Date.now()) {
    await closeParticipant(rt, reserved, "stale_admission");
    return fresh.kind !== "valid_claim"
      ? fresh
      : { kind: "admission_recovery", reason: "admission_failed" };
  }
  return mediaTransaction(rt, async (rt) => {
    const p = await rt.db
      .selectFrom("media_participants")
      .selectAll()
      .where("id", "=", claim.participantId)
      .where("generation", "=", claim.generation)
      .executeTakeFirstOrThrow();
    if (p.status !== "joining" && p.status !== "active")
      return admissionDisposition(claim.generation, p.reason);
    await rt.db
      .updateTable("media_participants")
      .set({ status: "active" })
      .where("id", "=", p.id)
      .where("generation", "=", p.generation)
      .execute();
    if (p.status === "joining") await revision(rt);
    return {
      kind: "admitted",
      producerVersion: (
        await rt.db
          .selectFrom("media_sessions")
          .select("version")
          .where("session_key", "=", sessionKey(p.id, p.generation, "producer"))
          .executeTakeFirstOrThrow()
      ).version,
      consumerVersion: (
        await rt.db
          .selectFrom("media_sessions")
          .select("version")
          .where("session_key", "=", sessionKey(p.id, p.generation, "consumer"))
          .executeTakeFirstOrThrow()
      ).version,
      snapshot: await roomSnapshot(rt, claim.room),
    };
  });
}

function admissionDisposition(
  generation: number,
  cause: Parameters<typeof closureDisposition>[0],
): MediaAdmissionOutcome {
  const disposition = closureDisposition(cause);
  return disposition.kind === "terminal"
    ? { kind: "participation_ended", generation, reason: disposition.reason }
    : { kind: "admission_recovery", reason: disposition.reason };
}

export async function admitParticipant(
  rt: RoomRuntime,
  claim: AccountClaim,
  authorization: MediaAuthorization,
): Promise<AdmitOutcome> {
  const key = `admission:${claim.participantId}:${claim.generation}`;
  const previous = rt.inflight.get(key);
  if (previous) return (await previous) as AdmitOutcome;
  const task = admitLogicalParticipant(rt, claim, authorization);
  rt.inflight.set(key, task);
  try {
    return await task;
  } finally {
    if (rt.inflight.get(key) === task) rt.inflight.delete(key);
  }
}
