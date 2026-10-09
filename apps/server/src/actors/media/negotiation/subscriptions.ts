import {
  mediaTransaction,
  sessionContext,
} from "@/server/actors/media/diagnostics";
import {
  MediaOutcomeSchema,
  type MediaOutcome,
  type SubscribeMediaRequest,
  type AnswerMediaRequest,
} from "@vaskel/contracts/media";
import type { Principal } from "@/server/domain/principal";
import type { MediaAuthorization } from "@/server/media/authorization";
import { sha256Hex } from "@/server/auth/crypto";
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
import {
  completed,
  currentSubscriptions,
  recordAllocations,
  sessionKey,
  type RoomRuntime,
} from "@/server/actors/media/store";
import { RealtimeError } from "@/server/providers/realtime";
import {
  subscriptionError,
  availablePublications,
} from "@/server/actors/media/permissions";

// Bound retained receiving resources independently of the 16-person roster.
// Retired publisher MIDs remain enforceable by deafen/Leave, without making
// their successful disposal a prerequisite for another publisher generation.
export const MAX_CONSUMER_ALLOCATIONS = 240;

export async function subscribe(
  rt: RoomRuntime,
  principal: Principal,
  authorization: MediaAuthorization,
  request: SubscribeMediaRequest,
): Promise<MediaOutcome> {
  const authorized = await authorizeParticipant(
    rt,
    principal,
    authorization,
    request.handle,
  );
  if (authorized.kind !== "participant") return authorized;
  const p = authorized.participant;
  const ids = [...new Set(request.publicationIds)];
  const reservation = await reserve(
    rt,
    principal,
    authorization,
    p,
    "consumer",
    request,
    subscriptionError,
    async () => {
      const rows = await availablePublications(rt, p.id, ids);
      if (rows.length !== ids.length)
        return { kind: "publication_unavailable" };
      const key = sessionKey(p.id, p.generation, "consumer");
      const existing = await rt.db
        .selectFrom("media_subscriptions")
        .select("publication_id")
        .where("session_key", "=", key)
        .execute();
      const allocated = await rt.db
        .selectFrom("media_allocations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("session_key", "=", key)
        .executeTakeFirstOrThrow();
      const additions = ids.filter(
        (id) =>
          !existing.some((subscription) => subscription.publication_id === id),
      ).length;
      return allocated.count + additions > MAX_CONSUMER_ALLOCATIONS
        ? { kind: "capacity" }
        : null;
    },
  );
  if (reservation.kind === "recovered") return reservation.result;
  if (reservation.kind !== "reserved") return reservation;
  let session = reservation.session;
  const release = allocationScope(rt, session.session_key);
  try {
    const publications = await availablePublications(rt, p.id, ids);
    if (publications.length !== ids.length) {
      release();
      await closeParticipant(rt, p, "publication_unavailable");
      return closedParticipation(rt, request.handle);
    }
    const old = await rt.db
      .selectFrom("media_subscriptions")
      .selectAll()
      .where("session_key", "=", session.session_key)
      .execute();
    const remove = old.filter((sub) => !ids.includes(sub.publication_id));
    // Only explicit transfer makes a receiving mapping disposable, even after source pruning.
    const close = remove.filter((sub) => sub.source_transferred === 0);
    await trackTask(rt, session.session_key, () =>
      closeMids(
        rt,
        session,
        close.map((sub) => sub.mid),
      ),
    );
    const add = publications.filter(
      (pub) => !old.some((sub) => sub.publication_id === pub.id),
    );
    const publishers = add.length
      ? await rt.db
          .selectFrom("media_sessions")
          .selectAll()
          .where(
            "session_key",
            "in",
            add.map((pub) => pub.session_key),
          )
          .execute()
      : [];
    if (add.length) {
      session = await ensureProviderSession(rt, session);
      const denied = await mediaTransaction(rt, (rt) =>
        operationError(
          rt,
          principal,
          authorization,
          request.handle,
          session,
          "requesting",
          subscriptionError,
        ),
      );
      if (denied) {
        release();
        await closeParticipant(rt, p, "subscription_revoked");
        return closedParticipation(rt, request.handle);
      }
    }
    const response = add.length
      ? await trackTask(rt, session.session_key, () =>
          rt.provider.addTracks(
            session.provider_id!,
            {
              tracks: add.map((pub) => ({
                location: "remote",
                sessionId: publishers.find(
                  (s) => s.session_key === pub.session_key,
                )!.provider_id!,
                trackName: pub.track_name,
              })),
            },
            sessionContext(rt, session),
          ),
        )
      : null;
    await recordAllocations(rt, session.session_key, response?.tracks ?? []);
    release();
    if (response?.tracks.some((track) => track.errorCode))
      throw new RealtimeError("partial_subscription", 502, false, true);
    if (
      response?.requiresImmediateRenegotiation &&
      response.sessionDescription?.type !== "offer"
    )
      throw new RealtimeError("missing_subscription_offer", 502, false, true);
    const allocations = add.map((pub) => {
      const result = response?.tracks.find(
        (track) =>
          track.trackName === pub.track_name &&
          track.sessionId ===
            publishers.find((s) => s.session_key === pub.session_key)
              ?.provider_id,
      );
      if (!result?.mid)
        throw new RealtimeError(
          "missing_subscription_allocation",
          502,
          false,
          true,
        );
      return {
        session_key: session.session_key,
        publication_id: pub.id,
        mid: result.mid,
        source_session_key: pub.session_key,
        source_transferred: 0,
      };
    });
    const fresh = await authorizeParticipant(
      rt,
      principal,
      authorization,
      request.handle,
    );
    if (fresh.kind !== "participant") {
      await closeParticipant(rt, p, "stale_subscription");
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
          subscriptionError,
        );
        if (denied) return denied;
        // The target can disappear or be muted while its SFU allocation is in flight.
        const current = await availablePublications(rt, p.id, ids);
        if (current.length !== ids.length)
          return { kind: "publication_unavailable" };
        for (const sub of remove)
          await rt.db
            .deleteFrom("media_subscriptions")
            .where("session_key", "=", session.session_key)
            .where("publication_id", "=", sub.publication_id)
            .execute();
        for (const allocation of allocations)
          await rt.db
            .insertInto("media_subscriptions")
            .values(allocation)
            .execute();
        if (!response?.requiresImmediateRenegotiation)
          return completed(rt, session, request.operationId);
        const deadline = Date.now() + 15_000;
        await rt.db
          .updateTable("media_sessions")
          .set({ phase: "awaiting_answer", deadline })
          .where("session_key", "=", session.session_key)
          .execute();
        const result: MediaOutcome = {
          kind: "negotiation",
          operationId: request.operationId,
          sessionVersion: session.version,
          phase: "awaiting_answer",
          sessionDescription: response.sessionDescription!,
          publications: [],
          subscriptions: await currentSubscriptions(rt, session.session_key),
          deadline,
        };
        await storeNegotiation(rt, session, result);
        await scheduleAlarm(rt.ctx.storage, deadline);
        return result;
      },
    );
    if (committed.kind !== "negotiation" && committed.kind !== "completed") {
      await closeParticipant(rt, p, "subscription_revoked");
      return closedParticipation(rt, request.handle);
    }
    return committed;
  } catch (error) {
    release();
    return failed(rt, p, error, request.handle, session, "subscribe");
  }
}

export async function answer(
  rt: RoomRuntime,
  principal: Principal,
  authorization: MediaAuthorization,
  request: AnswerMediaRequest,
): Promise<MediaOutcome> {
  const authorized = await authorizeParticipant(
    rt,
    principal,
    authorization,
    request.handle,
  );
  if (authorized.kind !== "participant") return authorized;
  const p = authorized.participant;
  const hash = await sha256Hex(
    JSON.stringify({
      type: request.sessionDescription.type,
      sdp: request.sessionDescription.sdp,
    }),
  );
  const reserved = await mediaTransaction(rt, async (rt) => {
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
      .where("session_key", "=", sessionKey(p.id, p.generation, "consumer"))
      .executeTakeFirstOrThrow();
    if (session.version !== request.expectedSessionVersion)
      return {
        kind: "stale_version" as const,
        currentVersion: session.version,
      };
    const op = await rt.db
      .selectFrom("media_operations")
      .selectAll()
      .where("participant_id", "=", p.id)
      .where("generation", "=", p.generation)
      .where("direction", "=", "consumer")
      .where("operation_id", "=", request.operationId)
      .executeTakeFirst();
    if (op?.answer_hash && op.answer_hash !== hash)
      return { kind: "command_conflict" as const };
    if (session.phase === "idle" && op?.result)
      return {
        kind: "recovered" as const,
        result: MediaOutcomeSchema.parse(JSON.parse(op.result)),
      };
    if (
      session.phase !== "awaiting_answer" ||
      session.operation_id !== request.operationId ||
      session.deadline <= Date.now()
    )
      return { kind: "negotiation_expired" as const };
    const denied = subscriptionError(current.participant);
    if (denied) {
      await markParticipantClosing(
        rt,
        current.participant,
        "subscription_revoked",
      );
      return { kind: "closing" as const };
    }
    await rt.db
      .updateTable("media_operations")
      .set({ answer_hash: hash })
      .where("participant_id", "=", p.id)
      .where("generation", "=", p.generation)
      .where("direction", "=", "consumer")
      .where("operation_id", "=", request.operationId)
      .execute();
    await rt.db
      .updateTable("media_sessions")
      .set({ phase: "answering", deadline: Date.now() + 10_000 })
      .where("session_key", "=", session.session_key)
      .execute();
    return { kind: "reserved" as const, session };
  });
  if (reserved.kind === "closing") {
    await closeParticipant(rt, p, "subscription_revoked");
    return closedParticipation(rt, request.handle);
  }
  if (reserved.kind === "recovered") return reserved.result;
  if (reserved.kind !== "reserved") return reserved;
  try {
    await trackTask(rt, reserved.session.session_key, () =>
      rt.provider.renegotiate(
        reserved.session.provider_id!,
        request.sessionDescription,
        sessionContext(rt, reserved.session),
      ),
    );
    const fresh = await authorizeParticipant(
      rt,
      principal,
      authorization,
      request.handle,
    );
    if (fresh.kind !== "participant") {
      await closeParticipant(rt, p, "stale_answer");
      return fresh;
    }
    const result = await mediaTransaction(rt, async (rt) => {
      const denied = await operationError(
        rt,
        principal,
        authorization,
        request.handle,
        reserved.session,
        "answering",
        subscriptionError,
      );
      if (denied) return denied;
      return completed(rt, reserved.session, request.operationId);
    });
    if (result.kind !== "completed") {
      await closeParticipant(rt, p, "answer_revoked");
      return closedParticipation(rt, request.handle);
    }
    return result;
  } catch (error) {
    return failed(rt, p, error, request.handle, reserved.session, "answer");
  }
}
