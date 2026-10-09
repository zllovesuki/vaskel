import { logEvent } from "@/server/telemetry";
import {
  mediaTransaction,
  sessionContext,
} from "@/server/actors/media/diagnostics";
import {
  MediaOutcomeSchema,
  type MediaOutcome,
  type MediaFailure,
  type MediaHandle,
  type PublishMediaRequest,
  type SubscribeMediaRequest,
  type UnpublishMediaRequest,
} from "@vaskel/contracts/media";
import type { Principal } from "@/server/domain/principal";
import type { MediaAuthorization } from "@/server/media/authorization";
import { commandTimeError } from "@/server/media/runtime";
import { sha256Hex } from "@/server/auth/crypto";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import { authorizeLocalParticipant } from "@/server/actors/media/authorization";
import {
  closeParticipant,
  closedParticipation,
  markParticipantClosing,
} from "@/server/actors/media/cleanup";
import { providerFailure } from "@/server/actors/media/membership";
import {
  sessionKey,
  type RoomRuntime,
  type SessionRow,
  type ParticipantRow,
} from "@/server/actors/media/store";

type Mutation =
  PublishMediaRequest | SubscribeMediaRequest | UnpublishMediaRequest;
type Reservation =
  | MediaFailure
  | { kind: "reserved"; session: SessionRow }
  | { kind: "recovered"; result: MediaOutcome };

function mutationPayload(request: Mutation) {
  const { handle } = request;
  return JSON.stringify({
    handle: {
      room: {
        owner: { kind: handle.room.owner.kind, id: handle.room.owner.id },
        channelId: handle.room.channelId,
      },
      participantId: handle.participantId,
      accountGeneration: handle.accountGeneration,
      clientId: handle.clientId,
      deviceToken: handle.deviceToken,
    },
    operationId: request.operationId,
    issuedAt: request.issuedAt,
    expectedSessionVersion: request.expectedSessionVersion,
    ...("tracks" in request
      ? {
          sessionDescription: {
            type: request.sessionDescription.type,
            sdp: request.sessionDescription.sdp,
          },
          tracks: request.tracks.map((track) => ({
            source: track.source,
            mid: track.mid,
          })),
        }
      : "publicationIds" in request
        ? { publicationIds: request.publicationIds }
        : { sources: request.sources }),
  });
}
export async function reserve(
  rt: RoomRuntime,
  principal: Principal,
  authorization: MediaAuthorization,
  p: ParticipantRow,
  direction: "producer" | "consumer",
  request: Mutation,
  validate?: (current: ParticipantRow) => MediaFailure | null,
  validateNew?: () => Promise<MediaFailure | null>,
): Promise<Reservation> {
  const hash = await sha256Hex(mutationPayload(request));
  const waitDeadline = Date.now() + 10_000;
  const attempt = () =>
    mediaTransaction(
      rt,
      async (
        rt,
      ): Promise<
        | Reservation
        | { kind: "closing" }
        | { kind: "moderating"; session: SessionRow }
      > => {
        const authorized = await authorizeLocalParticipant(
          rt,
          principal,
          authorization,
          request.handle,
        );
        if (authorized.kind !== "participant") return authorized;
        const key = sessionKey(p.id, p.generation, direction);
        const session = await rt.db
          .selectFrom("media_sessions")
          .selectAll()
          .where("session_key", "=", key)
          .executeTakeFirstOrThrow();
        const prior = await rt.db
          .selectFrom("media_operations")
          .selectAll()
          .where("participant_id", "=", p.id)
          .where("generation", "=", p.generation)
          .where("direction", "=", direction)
          .where("operation_id", "=", request.operationId)
          .executeTakeFirst();
        if (prior) {
          if (prior.payload_hash !== hash) return { kind: "command_conflict" };
          const result = prior.result
            ? MediaOutcomeSchema.parse(JSON.parse(prior.result))
            : null;
          // Completed receipts survive later source restrictions. Pending receipts
          // already own an exchange, so denial cannot be reported as preflight.
          if (result && result.kind !== "negotiation")
            return { kind: "recovered", result };
          const expired = commandTimeError(request.issuedAt);
          if (expired) return expired;
          if (session.deadline <= Date.now())
            return { kind: "negotiation_expired" };
          const denied = validate?.(authorized.participant);
          if (denied) {
            if (
              session.operation_id !== request.operationId ||
              session.version !== request.expectedSessionVersion + 1 ||
              session.phase === "idle" ||
              session.phase === "closed"
            )
              return { kind: "negotiation_expired" };
            await markParticipantClosing(
              rt,
              authorized.participant,
              "negotiation_failed",
            );
            return { kind: "closing" };
          }
          if (result)
            return {
              kind: "recovered",
              result,
            };
          return { kind: "session_busy", operationId: request.operationId };
        }
        const expired = commandTimeError(request.issuedAt);
        if (expired) return expired;
        const denied = validate?.(authorized.participant);
        if (denied) return denied;
        if (session.phase === "moderating")
          return { kind: "moderating", session };
        if (session.phase !== "idle")
          return session.operation_id
            ? { kind: "session_busy", operationId: session.operation_id }
            : { kind: "negotiation_expired" };
        if (session.version !== request.expectedSessionVersion)
          return { kind: "stale_version", currentVersion: session.version };
        const validation = await validateNew?.();
        if (validation) return validation;
        const reserved = {
          ...session,
          version: session.version + 1,
          phase: "requesting" as const,
          operation_id: request.operationId,
          deadline: Date.now() + 10_000,
        };
        await rt.db
          .updateTable("media_sessions")
          .set(reserved)
          .where("session_key", "=", key)
          .execute();
        await rt.db
          .insertInto("media_operations")
          .values({
            participant_id: p.id,
            generation: p.generation,
            direction,
            operation_id: request.operationId,
            payload_hash: hash,
            result: null,
            answer_hash: null,
            created_at: Date.now(),
          })
          .execute();
        await scheduleAlarm(rt.ctx.storage, reserved.deadline);
        return { kind: "reserved", session: reserved };
      },
    );
  let result = await attempt();
  if (result.kind === "moderating") {
    const scope = rt.inflight.get(`scope:${result.session.session_key}`);
    const remaining =
      Math.min(waitDeadline, result.session.deadline) - Date.now();
    if (!scope || remaining <= 0)
      return {
        kind: "session_busy",
        operationId: result.session.operation_id!,
      };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        scope.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), remaining);
        }),
      ]);
      if (!settled)
        return {
          kind: "session_busy",
          operationId: result.session.operation_id!,
        };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    // Recheck once after settlement. Workers' clocks need not advance across
    // resolved promises, so elapsed time cannot bound a reservation retry loop.
    result = await attempt();
  }
  if (result.kind === "moderating")
    return {
      kind: "session_busy",
      operationId: result.session.operation_id!,
    };
  if (result.kind === "closing") {
    await closeParticipant(rt, p, "negotiation_failed");
    return closedParticipation(rt, request.handle);
  }
  return result;
}
export async function storeNegotiation(
  rt: RoomRuntime,
  session: SessionRow,
  result: MediaOutcome,
) {
  await rt.db
    .updateTable("media_operations")
    .set({ result: JSON.stringify(result) })
    .where("participant_id", "=", session.participant_id)
    .where("generation", "=", session.generation)
    .where("direction", "=", session.direction)
    .where("operation_id", "=", session.operation_id!)
    .execute();
}
export async function failed(
  rt: RoomRuntime,
  p: ParticipantRow,
  error: unknown,
  handle: MediaHandle,
  session: SessionRow,
  operation: "publish" | "subscribe" | "answer" | "unpublish",
): Promise<MediaOutcome> {
  logEvent(
    "warn",
    "media_operation_failed",
    { ...sessionContext(rt, session), operation },
    error,
  );
  await closeParticipant(rt, p, "negotiation_failed");
  const failure = providerFailure(error);
  const disposition = await closedParticipation(rt, handle);
  return disposition.kind === "participation_ended" ? disposition : failure;
}
export async function trackTask<T>(
  rt: RoomRuntime,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const task = run();
  rt.inflight.set(key, task);
  try {
    return await task;
  } finally {
    if (rt.inflight.get(key) === task) rt.inflight.delete(key);
  }
}
/** The reserved exchange owns creation; a missing ID on retry is never permission to repeat it. */
export async function ensureProviderSession(
  rt: RoomRuntime,
  session: SessionRow,
) {
  if (session.provider_id) return session;
  const result = await trackTask(rt, session.session_key, () =>
    rt.provider.createSession(sessionContext(rt, session)),
  );
  // Retain even a late allocation before checking whether its authority survived.
  // The surrounding allocation scope protects this row from cleanup/pruning.
  await rt.db
    .updateTable("media_sessions")
    .set({ provider_id: result.sessionId })
    .where("session_key", "=", session.session_key)
    .execute();
  return { ...session, provider_id: result.sessionId };
}

export function allocationScope(rt: RoomRuntime, key: string) {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scoped = `scope:${key}`;
  rt.inflight.set(scoped, pending);
  return () => {
    release();
    if (rt.inflight.get(scoped) === pending) rt.inflight.delete(scoped);
  };
}
/** Recheck authority and the owned exchange inside its native commit. */
export async function operationError(
  rt: RoomRuntime,
  principal: Principal,
  authorization: MediaAuthorization,
  handle: MediaHandle,
  session: SessionRow,
  phase: SessionRow["phase"],
  validate?: (current: ParticipantRow) => MediaFailure | null,
): Promise<MediaFailure | null> {
  const authorized = await authorizeLocalParticipant(
    rt,
    principal,
    authorization,
    handle,
  );
  if (authorized.kind !== "participant") return authorized;
  const denied = validate?.(authorized.participant);
  if (denied) return denied;
  const current = await rt.db
    .selectFrom("media_sessions")
    .selectAll()
    .where("session_key", "=", session.session_key)
    .executeTakeFirstOrThrow();
  if (
    current.operation_id !== session.operation_id ||
    current.version !== session.version ||
    current.phase !== phase ||
    current.deadline <= Date.now()
  )
    return { kind: "negotiation_expired" };
  return null;
}
