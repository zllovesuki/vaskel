import {
  mediaTransaction,
  sessionContext,
} from "@/server/actors/media/diagnostics";
import {
  revision,
  completed,
  publicPublication,
  recordAllocations,
  sessionKey,
  type RoomRuntime,
} from "@/server/actors/media/store";
import {
  MediaOutcomeSchema,
  type MediaOutcome,
  type PublishMediaRequest,
  type AckMediaRequest,
  type UnpublishMediaRequest,
} from "@vaskel/contracts/media";
import type { Principal } from "@/server/domain/principal";
import type { MediaAuthorization } from "@/server/media/authorization";
import { scheduleAlarm } from "@/server/actors/shared/alarms";
import {
  authorizeParticipant,
  authorizeLocalParticipant,
} from "@/server/actors/media/authorization";
import {
  closeMids,
  closeParticipant,
  closedParticipation,
  markParticipantClosing,
} from "@/server/actors/media/cleanup";
import {
  reserve,
  operationError,
  storeNegotiation,
  failed,
  trackTask,
  allocationScope,
  ensureProviderSession,
} from "@/server/actors/media/operations";
import { RealtimeError } from "@/server/providers/realtime";
import { publicationError } from "@/server/actors/media/permissions";
import { offeredSourcesMatch } from "@/server/actors/media/sdp";

export async function publish(
  rt: RoomRuntime,
  principal: Principal,
  authorization: MediaAuthorization,
  request: PublishMediaRequest,
): Promise<MediaOutcome> {
  const authorized = await authorizeParticipant(
    rt,
    principal,
    authorization,
    request.handle,
  );
  if (authorized.kind !== "participant") return authorized;
  const p = authorized.participant;
  if (
    new Set(request.tracks.map((track) => track.source)).size !==
      request.tracks.length ||
    new Set(request.tracks.map((track) => track.mid)).size !==
      request.tracks.length
  )
    return { kind: "invalid_input" };
  if (!offeredSourcesMatch(request.sessionDescription.sdp, request.tracks))
    return { kind: "invalid_input" };
  const permission = (current: typeof p) =>
    publicationError(
      current,
      authorization,
      request.tracks.map((track) => track.source),
    );
  const reservation = await reserve(
    rt,
    principal,
    authorization,
    p,
    "producer",
    request,
    permission,
    async () => {
      const old = await rt.db
        .selectFrom("media_publications")
        .select("source")
        .where("participant_id", "=", p.id)
        .where("generation", "=", p.generation)
        .where("ready", "=", 1)
        .execute();
      return request.tracks.some((track) =>
        old.some((existing) => existing.source === track.source),
      )
        ? { kind: "invalid_input" }
        : null;
    },
  );
  if (reservation.kind === "recovered") return reservation.result;
  if (reservation.kind !== "reserved") return reservation;
  let session = reservation.session;
  const release = allocationScope(rt, session.session_key);
  try {
    session = await ensureProviderSession(rt, session);
    const names = request.tracks.map((track) => ({
      ...track,
      id: crypto.randomUUID(),
      trackName: `${p.id}-${p.generation}-${track.source}-${crypto.randomUUID()}`,
    }));
    const staged = await mediaTransaction(rt, async (rt) => {
      const denied = await operationError(
        rt,
        principal,
        authorization,
        request.handle,
        session,
        "requesting",
        permission,
      );
      if (denied) return denied;
      await recordAllocations(rt, session.session_key, names);
      for (const track of names) {
        await rt.db
          .insertInto("media_publications")
          .values({
            id: track.id,
            participant_id: p.id,
            generation: p.generation,
            source: track.source,
            session_key: session.session_key,
            mid: track.mid,
            track_name: track.trackName,
            ready: 0,
          })
          .execute();
      }
    });
    if (staged) {
      release();
      await closeParticipant(rt, p, "publication_revoked");
      return closedParticipation(rt, request.handle);
    }
    const response = await trackTask(rt, session.session_key, () =>
      rt.provider.addTracks(
        session.provider_id!,
        {
          sessionDescription: request.sessionDescription,
          tracks: names.map((track) => ({
            location: "local",
            mid: track.mid,
            trackName: track.trackName,
          })),
        },
        sessionContext(rt, session),
      ),
    );
    await recordAllocations(rt, session.session_key, response.tracks);
    release();
    if (
      response.tracks.some((track) => track.errorCode) ||
      !response.sessionDescription ||
      response.sessionDescription.type !== "answer" ||
      response.requiresImmediateRenegotiation
    )
      throw new RealtimeError("invalid_publishing_result", 502, false, true);
    const fresh = await authorizeParticipant(
      rt,
      principal,
      authorization,
      request.handle,
    );
    if (fresh.kind !== "participant") {
      await closeParticipant(rt, p, "stale_publication");
      return fresh;
    }
    const committed = await mediaTransaction(
      rt,
      async (rt): Promise<MediaOutcome> => {
        const denied = await operationError(
          rt,
          principal,
          authorization,
          request.handle,
          session,
          "requesting",
          permission,
        );
        if (denied) return denied;
        const deadline = Date.now() + 15_000;
        await rt.db
          .updateTable("media_sessions")
          .set({ phase: "awaiting_apply", deadline })
          .where("session_key", "=", session.session_key)
          .execute();
        const pubs = await rt.db
          .selectFrom("media_publications")
          .selectAll()
          .where("session_key", "=", session.session_key)
          .execute();
        const result: MediaOutcome = {
          kind: "negotiation",
          operationId: request.operationId,
          sessionVersion: session.version,
          phase: "awaiting_apply",
          sessionDescription: response.sessionDescription!,
          publications: pubs.map(publicPublication),
          subscriptions: [],
          deadline,
        };
        await storeNegotiation(rt, session, result);
        await scheduleAlarm(rt.ctx.storage, deadline);
        return result;
      },
    );
    if (committed.kind !== "negotiation") {
      await closeParticipant(rt, p, "publication_revoked");
      return closedParticipation(rt, request.handle);
    }
    return committed;
  } catch (error) {
    release();
    return failed(rt, p, error, request.handle, session, "publish");
  }
}

export async function ack(
  rt: RoomRuntime,
  principal: Principal,
  authorization: MediaAuthorization,
  request: AckMediaRequest,
): Promise<MediaOutcome> {
  const authorized = await authorizeParticipant(
    rt,
    principal,
    authorization,
    request.handle,
  );
  if (authorized.kind !== "participant") return authorized;
  const p = authorized.participant;
  const result = await mediaTransaction(
    rt,
    async (rt): Promise<MediaOutcome | { kind: "closing" }> => {
      const current = await authorizeLocalParticipant(
        rt,
        principal,
        authorization,
        request.handle,
      );
      if (current.kind !== "participant") return current;
      const session = await rt.db
        .selectFrom("media_sessions")
        .selectAll()
        .where("session_key", "=", sessionKey(p.id, p.generation, "producer"))
        .executeTakeFirstOrThrow();
      if (session.version !== request.expectedSessionVersion)
        return { kind: "stale_version", currentVersion: session.version };
      const prior = await rt.db
        .selectFrom("media_operations")
        .select("result")
        .where("participant_id", "=", p.id)
        .where("generation", "=", p.generation)
        .where("direction", "=", "producer")
        .where("operation_id", "=", request.operationId)
        .executeTakeFirst();
      if (session.phase === "idle" && prior?.result)
        return MediaOutcomeSchema.parse(JSON.parse(prior.result));
      if (
        session.phase !== "awaiting_apply" ||
        session.operation_id !== request.operationId ||
        session.deadline <= Date.now()
      )
        return { kind: "negotiation_expired" };
      const negotiation = MediaOutcomeSchema.parse(
        JSON.parse(prior?.result ?? "null"),
      );
      if (negotiation.kind !== "negotiation")
        throw new Error(
          "Pending publishing exchange lost its negotiation receipt.",
        );
      const denied = publicationError(
        current.participant,
        authorization,
        negotiation.publications.map((publication) => publication.source),
      );
      if (denied) {
        await markParticipantClosing(
          rt,
          current.participant,
          "publication_revoked",
        );
        return { kind: "closing" };
      }
      await rt.db
        .updateTable("media_publications")
        .set({ ready: 1 })
        .where("session_key", "=", session.session_key)
        .execute();
      return completed(rt, session, request.operationId);
    },
  );
  if (result.kind === "closing") {
    await closeParticipant(rt, p, "publication_revoked");
    return closedParticipation(rt, request.handle);
  }
  return result;
}

export async function unpublish(
  rt: RoomRuntime,
  principal: Principal,
  authorization: MediaAuthorization,
  request: UnpublishMediaRequest,
): Promise<MediaOutcome> {
  const authorized = await authorizeParticipant(
    rt,
    principal,
    authorization,
    request.handle,
  );
  if (authorized.kind !== "participant") return authorized;
  const p = authorized.participant;
  const reserved = await reserve(
    rt,
    principal,
    authorization,
    p,
    "producer",
    request,
  );
  if (reserved.kind === "recovered") return reserved.result;
  if (reserved.kind !== "reserved") return reserved;
  try {
    const sources = request.sources.includes("screen_video")
      ? [...new Set([...request.sources, "screen_audio" as const])]
      : request.sources;
    const pubs = await rt.db
      .selectFrom("media_publications")
      .selectAll()
      .where("session_key", "=", reserved.session.session_key)
      .where("source", "in", sources)
      .execute();
    await mediaTransaction(rt, async (rt) => {
      await rt.db
        .updateTable("media_publications")
        .set({ ready: 0 })
        .where(
          "id",
          "in",
          pubs.map((pub) => pub.id),
        )
        .execute();
      await revision(rt);
    });
    await trackTask(rt, reserved.session.session_key, () =>
      closeMids(
        rt,
        reserved.session,
        pubs.map((pub) => pub.mid),
      ),
    );
    await rt.db
      .deleteFrom("media_publications")
      .where(
        "id",
        "in",
        pubs.map((pub) => pub.id),
      )
      .execute();
    const fresh = await authorizeParticipant(
      rt,
      principal,
      authorization,
      request.handle,
    );
    if (fresh.kind !== "participant") {
      await closeParticipant(rt, p, "stale_unpublish");
      return fresh;
    }
    const result = await mediaTransaction(rt, async (rt) => {
      const denied = await operationError(
        rt,
        principal,
        authorization,
        request.handle,
        reserved.session,
        "requesting",
      );
      if (denied) return denied;
      return completed(rt, reserved.session, request.operationId);
    });
    if (result.kind !== "completed") {
      await closeParticipant(rt, p, "unpublish_revoked");
      return closedParticipation(rt, request.handle);
    }
    return result;
  } catch (error) {
    return failed(rt, p, error, request.handle, reserved.session, "unpublish");
  }
}
